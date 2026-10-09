import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Buffer } from 'node:buffer'
import { Socket } from 'node:net'
import { spawnSync } from 'node:child_process'
import {
  quoteWindowsArgument,
  launchIndependent,
  windowsSuiteLauncher,
} from '../installer/windows-lifecycle.mjs'

const repo = fileURLToPath(new URL('..', import.meta.url))
const isWindows = process.platform === 'win32'
const windowsOnly = isWindows ? false : 'requires Windows Job objects'

// A test-owned target: it binds a private 127.0.0.1 port and answers a ping, so
// "survived" is proven by real IPC rather than a liveness guess.
function writeTarget(dir) {
  const nested = join(dir, '中文 目录')
  mkdirSync(nested, { recursive: true })
  const target = join(nested, 'target.mjs')
  const info = join(dir, 'target.info.json')
  const log = join(dir, 'target.jsonl')
  writeFileSync(
    target,
    `import { createServer } from 'node:net'
import { writeFileSync, appendFileSync } from 'node:fs'
const [, , info, log, token] = process.argv
const deadline = Date.now() + 120000
const server = createServer((s) => s.once('data', (c) => {
  const request = c.toString().trim()
  s.end(request === 'ping' || request === 'stop:' + token ? 'pong:' + token : 'err')
  if (request === 'stop:' + token) s.on('close', () => process.exit(0))
}))
server.listen(0, '127.0.0.1', () => {
  writeFileSync(info, JSON.stringify({
    pid: process.pid, exe: process.execPath, port: server.address().port, token,
    dshHome: process.env.DSH_HOME ?? null,
  }))
  appendFileSync(log, 'listening\\n')
})
setInterval(() => {
  appendFileSync(log, 'alive\\n')
  if (Date.now() > deadline) process.exit(0)
}, 400)
`,
  )
  return { target, info, log, nested }
}

function probeIpc(port, token, request = 'ping') {
  return new Promise((resolve) => {
    const socket = new Socket()
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(4000)
    socket.on('error', (e) => finish({ ok: false, err: String(e) }))
    socket.on('timeout', () => finish({ ok: false, err: 'timeout' }))
    socket.connect(port, '127.0.0.1', () => socket.write(request))
    socket.on('data', (chunk) => {
      const reply = chunk.toString('utf8').trim()
      finish({ ok: reply === 'pong:' + token, reply })
    })
  })
}

// A self-contained Job supervisor. It creates its own Job, fails loudly when an
// API call fails, keeps live handles, and only cleans up a process whose PID,
// image path and creation time still match what it recorded at launch.
const supervisorScript = `
$ErrorActionPreference = 'Stop'
$dir = $env:OPL_TRIAL_DIR
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class T {
  [StructLayout(LayoutKind.Sequential)] public struct BBLI {
    public long a; public long b; public uint LimitFlags; public UIntPtr c; public UIntPtr d;
    public uint ActiveProcessLimit; public UIntPtr e; public uint f; public uint g;
  }
  [StructLayout(LayoutKind.Sequential)] public struct IOC {
    public ulong a; public ulong b; public ulong c; public ulong d; public ulong e; public ulong f;
  }
  [StructLayout(LayoutKind.Sequential)] public struct ELI {
    public BBLI BasicLimitInformation; public IOC IoInfo;
    public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
  }
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr j, int c, IntPtr i, uint l);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool QueryInformationJobObject(IntPtr j, int c, IntPtr i, uint l, out uint r);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint a, bool i, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetExitCodeProcess(IntPtr h, out uint c);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool TerminateProcess(IntPtr h, uint c);
  [DllImport("kernel32.dll")] public static extern bool IsProcessInJob(IntPtr p, IntPtr j, out bool r);
}
'@
$out = [ordered]@{}
$job = [IntPtr]::Zero; $runnerH = [IntPtr]::Zero; $targetH = [IntPtr]::Zero
$runner = $null; $tpid = 0
try {
  $job = [T]::CreateJobObject([IntPtr]::Zero, $null)
  if ($job -eq [IntPtr]::Zero) { throw "CreateJobObject failed" }
  # Build both structs whole: PowerShell copies nested struct fields on read.
  $basic = New-Object T+BBLI; $basic.LimitFlags = [uint32]0x00002000
  $eli = New-Object T+ELI; $eli.BasicLimitInformation = $basic
  $size = [uint32][System.Runtime.InteropServices.Marshal]::SizeOf([type][T+ELI])
  $out.structSize = $size
  $lp = [System.Runtime.InteropServices.Marshal]::AllocHGlobal([int]$size)
  try {
    [System.Runtime.InteropServices.Marshal]::StructureToPtr($eli, $lp, $false)
    if (-not [T]::SetInformationJobObject($job, 9, $lp, $size)) { throw "SetInformationJobObject failed" }
  } finally { [System.Runtime.InteropServices.Marshal]::FreeHGlobal($lp) }
  $rp = [System.Runtime.InteropServices.Marshal]::AllocHGlobal([int]$size)
  try {
    $n = 0
    if (-not [T]::QueryInformationJobObject($job, 9, $rp, $size, [ref]$n)) { throw "QueryInformationJobObject readback failed" }
    $back = [System.Runtime.InteropServices.Marshal]::PtrToStructure($rp, [type][T+ELI])
    $out.jobLimitFlags = ('0x{0:X8}' -f $back.BasicLimitInformation.LimitFlags)
  } finally { [System.Runtime.InteropServices.Marshal]::FreeHGlobal($rp) }

  $gate = Join-Path $dir 'gate'
  $result = Join-Path $dir 'result.json'
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $env:OPL_NODE
  $psi.Arguments = '"' + $env:OPL_RUNNER + '" "' + $gate + '"'
  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true; $psi.WorkingDirectory = $dir
  $runner = [System.Diagnostics.Process]::Start($psi)
  $runnerH = [T]::OpenProcess(0x1F0FFF, $false, [uint32]$runner.Id)
  if ($runnerH -eq [IntPtr]::Zero) { throw "OpenProcess(runner) failed" }
  if (-not [T]::AssignProcessToJobObject($job, $runnerH)) { throw "AssignProcessToJobObject failed" }
  New-Item -ItemType File -Force -Path $gate | Out-Null

  $deadline = (Get-Date).AddSeconds(60)
  while (-not (Test-Path $result) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 150 }
  if (-not (Test-Path $result)) { throw 'runner produced no result.json' }
  $launch = Get-Content $result -Raw | ConvertFrom-Json
  $out.helper = $launch
  if ($launch.pid) { $tpid = [int]$launch.pid }

  $deadline = (Get-Date).AddSeconds(30)
  while (-not (Test-Path $env:OPL_TARGET_INFO) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 150 }
  if (-not (Test-Path $env:OPL_TARGET_INFO)) { throw 'target never reported identity' }
  $info = Get-Content $env:OPL_TARGET_INFO -Raw | ConvertFrom-Json
  if ([int]$info.pid -ne $tpid) { throw 'target pid mismatch' }
  $proc = Get-Process -Id $tpid -ErrorAction Stop
  if ([System.IO.Path]::GetFullPath($info.exe) -ne [System.IO.Path]::GetFullPath($proc.Path)) { throw 'image path mismatch' }
  $out.image = $proc.Path
  $out.startTicks = $proc.StartTime.ToUniversalTime().Ticks
  $out.port = [int]$info.port
  $out.token = $info.token
  $out.dshHome = $info.dshHome

  $targetH = [T]::OpenProcess(0x1F0FFF, $false, [uint32]$tpid)
  if ($targetH -eq [IntPtr]::Zero) { throw "OpenProcess(target) failed" }
  $inJob = $false
  if (-not [T]::IsProcessInJob($targetH, $job, [ref]$inJob)) { throw "IsProcessInJob failed" }
  $out.inJobBeforeClose = $inJob

  [T]::CloseHandle($job) | Out-Null; $job = [IntPtr]::Zero
  Start-Sleep -Milliseconds 2500

  $code = [uint32]0
  $open = [T]::GetExitCodeProcess($targetH, [ref]$code)
  $alive = $open -and ($code -eq 259)
  $out.survived = $alive
  $out.exitCode = $code
  if ($alive) {
    $c = New-Object System.Net.Sockets.TcpClient
    $c.Connect('127.0.0.1', $out.port); $c.ReceiveTimeout = 3000; $c.SendTimeout = 3000
    $st = $c.GetStream(); $b = [System.Text.Encoding]::UTF8.GetBytes('ping'); $st.Write($b, 0, $b.Length)
    $buf = New-Object byte[] 256; $got = $st.Read($buf, 0, 256)
    $out.ipc = [System.Text.Encoding]::UTF8.GetString($buf, 0, $got); $c.Close()
  }
} catch { $out.error = $_.Exception.Message }
finally {
  if ($job -ne [IntPtr]::Zero) { [T]::CloseHandle($job) | Out-Null }
  if ($runner -and -not $runner.HasExited) { try { $runner.Kill() } catch {} }
  if ($runnerH -ne [IntPtr]::Zero) { [T]::CloseHandle($runnerH) | Out-Null }
  if ($targetH -ne [IntPtr]::Zero) {
    $code = [uint32]0
    if ([T]::GetExitCodeProcess($targetH, [ref]$code) -and $code -eq 259) {
      $p = Get-Process -Id $tpid -ErrorAction SilentlyContinue
      $ok = $p -and $p.StartTime.ToUniversalTime().Ticks -eq $out.startTicks -and
            [System.IO.Path]::GetFullPath($p.Path) -eq [System.IO.Path]::GetFullPath($out.image)
      if ($ok) { [T]::TerminateProcess($targetH, 0) | Out-Null } else { $out.cleanupRefused = $true }
    }
    [T]::CloseHandle($targetH) | Out-Null
  }
  $out | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $dir 'supervisor.json') -Encoding UTF8
}
`

function runJobTrial({ label, negativeControl = false }) {
  const dir = mkdtempSync(join(tmpdir(), 'opl-job-'))
  const { target, info, log } = writeTarget(dir)
  const token = 'tk' + Math.random().toString(16).slice(2, 10)
  const runner = join(dir, 'runner.mjs')
  const targetArgs = JSON.stringify([target, info, log, token])
  const launch = negativeControl
    ? `(() => { const child = spawn(process.execPath, ${targetArgs}, { detached: true, stdio: 'ignore' }); child.unref(); return { pid: child.pid, method: 'detached' }; })()`
    : `module.launchIndependent({ command: process.execPath, args: ${targetArgs}, label: ${JSON.stringify(label)} })`
  writeFileSync(
    runner,
    `import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
const [, , gate] = process.argv
while (!existsSync(gate)) await new Promise((r) => setTimeout(r, 25))
const module = await import(pathToFileURL(${JSON.stringify(join(repo, 'installer/windows-lifecycle.mjs'))}).href)
const started = ${launch}
writeFileSync(join(dirname(gate), 'result.json'), JSON.stringify(started))
process.exit(0)
`,
  )
  const encoded = Buffer.from(supervisorScript, 'utf16le').toString('base64')
  const run = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    {
      env: {
        ...process.env,
        OPL_TRIAL_DIR: dir,
        OPL_RUNNER: runner,
        OPL_NODE: process.execPath,
        OPL_TARGET_INFO: info,
      },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 180000,
    },
  )
  const file = join(dir, 'supervisor.json')
  assert.ok(
    existsSync(file),
    'supervisor must produce a result: ' + (run.stderr || '').slice(0, 300),
  )
  const result = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''))
  rmSync(dir, { recursive: true, force: true })
  return { result }
}

test('argument quoting keeps spaces, non-ASCII and quotes parseable', () => {
  assert.equal(quoteWindowsArgument('plain'), 'plain')
  assert.equal(quoteWindowsArgument('C:\\Program Files\\app.exe'), '"C:\\Program Files\\app.exe"')
  assert.equal(quoteWindowsArgument('C:\\测试 目录\\DSH Home'), '"C:\\测试 目录\\DSH Home"')
  assert.equal(quoteWindowsArgument('C:\\path with space\\'), '"C:\\path with space\\\\"')
  assert.equal(quoteWindowsArgument('a"b'), '"a\\"b"')
  assert.equal(quoteWindowsArgument(''), '""')
})

test(
  'the Suite launcher preserves the configured Codex home and profile argv',
  { skip: windowsOnly },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opl-launch-env-'))
    try {
      const nested = join(dir, '中文 目录')
      mkdirSync(nested)
      const result = join(dir, 'environment.json')
      const setup = join(nested, 'setup.mjs')
      const home = join(nested, 'DSH home'),
        root = join(nested, 'Suite root'),
        app = join(nested, 'app')
      const codexHome = join(nested, 'Codex home')
      writeFileSync(
        setup,
        `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(result)}, JSON.stringify({codexHome:process.env.CODEX_HOME,args:process.argv.slice(2)}))`,
      )
      const vbs = join(dir, 'launch.vbs')
      writeFileSync(
        vbs,
        '\ufeff' +
          windowsSuiteLauncher({ executable: process.execPath, setup, home, root, app, codexHome }),
        'utf16le',
      )
      const launched = spawnSync('wscript.exe', [vbs], { windowsHide: true, timeout: 10000 })
      assert.equal(launched.status, 0)
      const deadline = Date.now() + 10000
      while (!existsSync(result) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 50))
      assert.ok(existsSync(result), 'the launcher must execute its setup program')
      assert.deepEqual(JSON.parse(readFileSync(result, 'utf8')), {
        codexHome,
        args: [home, root, app],
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

test('a non-Windows platform reports inheritance instead of a fake guarantee', () => {
  if (isWindows) return
  const started = launchIndependent({
    command: process.execPath,
    args: ['-e', 'setTimeout(()=>{},50)'],
  })
  assert.equal(started.method, 'posix-inherit')
  assert.equal(started.guarantee, 'not-applicable')
  assert.equal(started.refusal, undefined)
})

test(
  'a real launch starts a process on a Unicode path with a space',
  { skip: windowsOnly },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opl-launch-'))
    try {
      const { target, info, log } = writeTarget(dir)
      const token = 'tklive'
      const started = launchIndependent({
        command: process.execPath,
        args: [target, info, log, token],
        label: 'real-launch',
      })
      assert.equal(started.refusal, undefined)
      assert.equal(typeof started.pid, 'number')
      assert.equal(started.method, 'wmi-broker')
      assert.equal(started.guarantee, 'job-independent')
      const deadline = Date.now() + 30000
      while (!existsSync(info) && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 150))
      assert.ok(existsSync(info), 'the launched process must report itself')
      const reported = JSON.parse(readFileSync(info, 'utf8'))
      assert.equal(reported.pid, started.pid)
      const reply = await probeIpc(reported.port, token)
      assert.equal(reply.ok, true, JSON.stringify(reply))
      assert.equal(reply.reply, 'pong:' + token)
      const stopped = await probeIpc(reported.port, token, 'stop:' + token)
      assert.equal(stopped.ok, true, JSON.stringify(stopped))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

test(
  'detached spawning remains in the hostile Job and dies when it closes',
  { skip: windowsOnly },
  () => {
    const { result } = runJobTrial({ label: 'negative-control', negativeControl: true })
    assert.equal(result.error, undefined, result.error)
    assert.equal(result.jobLimitFlags, '0x00002000')
    assert.equal(result.helper.method, 'detached')
    assert.equal(result.inJobBeforeClose, true)
    assert.equal(result.survived, false)
    assert.notEqual(result.exitCode, 259)
  },
)

test(
  'a failing broker refuses instead of claiming an independent start',
  { skip: windowsOnly },
  () => {
    const started = launchIndependent({
      command: join(tmpdir(), 'opl-does-not-exist-9f3a.exe'),
      args: [],
    })
    assert.equal(started.guarantee, 'none')
    assert.equal(typeof started.refusal, 'string')
    assert.match(started.refusal, /不会退回到与 Codex 共享的 Job/)
  },
)

test(
  'the process outlives a hostile Job that kills its launcher',
  { skip: windowsOnly, timeout: 240000 },
  async () => {
    const { result } = runJobTrial({ label: 'hostile-job' })
    assert.equal(result.error, undefined, 'supervisor APIs must not fail: ' + (result.error ?? ''))
    assert.equal(result.jobLimitFlags, '0x00002000', 'the test Job must forbid breakaway')
    assert.equal(result.helper.method, 'wmi-broker')
    assert.equal(result.helper.guarantee, 'job-independent')
    assert.equal(result.inJobBeforeClose, false, 'the target must be outside the test Job')
    assert.equal(result.survived, true, 'the target must survive the Job closing')
    assert.equal(result.exitCode, 259, 'it must still be running')
    assert.equal(result.ipc, 'pong:' + result.token, 'and must still answer IPC')
    assert.equal(result.cleanupRefused, undefined)
  },
)

// The only static check here is the install-manifest gate: without the shared
// module in the payload the installer throws ENOENT at install time.
test('the launch payload ships the shared module', () => {
  const build = readFileSync(join(repo, 'build.mjs'), 'utf8')
  const payload = build.slice(
    build.indexOf('const payloadFiles = {}'),
    build.indexOf('suiteSha256'),
  )
  assert.match(
    payload,
    /'windows-lifecycle\.mjs'/,
    "build.mjs must list 'windows-lifecycle.mjs' in the payloadFiles allowlist",
  )
})
