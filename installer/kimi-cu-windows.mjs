/** Install the official Windows code-mode plugin without starting its native Agent. */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

export const WINDOWS_KIMI_CU_VERSION = '0.3.10'
export const WINDOWS_KIMI_CU_MANIFEST_URL =
  'https://cdn.kimi.com/kimi-computer-use-windows/0.3.10/version.json'
export const WINDOWS_KIMI_CU_SIGNER = '6DA99CCA99A69947C11F97395A55FD2DC683420D'
const base = 'https://cdn.kimi.com/kimi-computer-use-windows/0.3.10/'
const hashes = {
  plugin: 'aae21d2b5b8eb601f8f89b29e3ccc3ffab32db95f009a1e7e0a5409eefe4cea9',
  runtime: '46e2900b93353af6f44391451126575967192340daa3b952b34e92f6a88a9bd4',
}
const nativeHash = 'ab33418e9bf042775116a9334cb3ea5be923cc8ebcead1c060d86f9742f96936'
const runtimeFiles = {
  'INSTALL.md': '1867f3b6a62e1827be24301b1a3106a340625b0664d9941b5f13666f06e739c9',
  'install_runtime.ps1': '4f35cc5467dc5d18fd3e292930a6ddf65c877ae9170796af88137ddb270800da',
  'kimi-cu.exe': nativeHash,
  'runtime-layout.json': 'e8fe44dce54a7af0fcd8e700c587e0154ebb2d6cb36a587499c440c31afc20a5',
  'runtime_layout.ps1': '4746662cd035baef1a58bbd8d951bd7c3a202e3106ec9b90c79539981f9ab335',
  'THIRD_PARTY_NOTICES.md': 'ff564924ccc05f9c371d447ab928873dd52f286aa5151eb431ff2db382722af8',
  'verify_windows_signature.ps1':
    '212799350e4163cc98ec60141925b18aa1a03d607a87b7ac4279d95cb3d9f4fc',
}
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** Reject paths that Windows would interpret outside an ordinary relative archive entry. */
export function validateWindowsKimiCuEntry(name) {
  const parts = name.replaceAll(String.fromCharCode(92), '/').replace(/\/$/u, '').split('/')
  if (
    !name ||
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        /[:\x00-\x1f<>"|?*]/u.test(part) ||
        /[. ]$/u.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
    )
  )
    throw Error('KimiCU ZIP 包含不安全路径')
  return name
}

/** Accept only the pinned official release, URLs, archive digests and signing identity. */
export function windowsKimiCuRelease(manifest) {
  if (
    manifest?.version !== WINDOWS_KIMI_CU_VERSION ||
    manifest.runtime?.signer_sha1 !== WINDOWS_KIMI_CU_SIGNER ||
    manifest.runtime?.executable_sha256 !== nativeHash ||
    manifest.runtime?.executable_url !== `${base}kimi-cu.exe`
  )
    throw Error('KimiCU Windows 官方清单版本或签名身份不匹配')
  for (const kind of ['plugin', 'runtime']) {
    if (
      manifest[kind]?.url !== `${base}kimi-cu-win-${kind}.zip` ||
      manifest[kind]?.sha256 !== hashes[kind]
    )
      throw Error('KimiCU Windows 官方归档地址或 SHA-256 不匹配')
  }
  return manifest
}

async function download(url, limit, fetchImpl) {
  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw Error(`KimiCU 下载失败 HTTP ${response.status}`)
  if (Number(response.headers.get('content-length')) > limit) throw Error('KimiCU 下载超过大小上限')
  const chunks = []
  let length = 0
  if (!response.body) throw Error('KimiCU 下载内容为空')
  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > limit) {
        await reader.cancel()
        throw Error('KimiCU 下载超过大小上限')
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, length)
}

function powershell(script, env) {
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ${script}`,
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120_000,
      env: { ...process.env, ...env },
      maxBuffer: 1024 * 1024,
    },
  )
  if (result.error || result.status !== 0)
    throw Error(`KimiCU Windows 校验失败：${result.error?.message ?? result.stderr?.trim()}`)
  return result.stdout.trim()
}

/** Verify Authenticode trust and the pinned publisher certificate without executing the file. */
export function verifyWindowsKimiCuSignature(path) {
  const output = powershell(
    "$ErrorActionPreference='Stop'; $s=Get-AuthenticodeSignature -LiteralPath $env:OPL_KIMI_VERIFY; if($s.Status -ne 'Valid' -or $s.SignerCertificate.Thumbprint -ne $env:OPL_KIMI_SIGNER){throw 'Authenticode 签名或发布者不匹配'}; 'verified'",
    { OPL_KIMI_VERIFY: path, OPL_KIMI_SIGNER: WINDOWS_KIMI_CU_SIGNER },
  )
  if (output !== 'verified') throw Error('KimiCU Authenticode 校验未完成')
}

/** Extract only regular ZIP entries after checking paths, aliases and expansion bounds. */
export function unpackWindowsKimiCu(archive, destination) {
  powershell(
    String.raw`$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip=[IO.Compression.ZipFile]::OpenRead($env:OPL_KIMI_ZIP)
try {
 $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
 $total=0L
 foreach($entry in $zip.Entries){
  $name=$entry.FullName.Replace('\','/').TrimEnd('/')
  if(!$name){throw 'ZIP empty path'}
  foreach($part in $name.Split('/')){
   if(!$part -or $part -eq '.' -or $part -eq '..' -or $part -match '[:\x00-\x1f<>"|?*]' -or $part -match '[. ]$' -or $part -match '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)'){throw 'ZIP unsafe path'}
  }
  if(!$seen.Add($name)){throw 'ZIP duplicate path'}
  $type=($entry.ExternalAttributes -shr 16) -band 61440
  if($type -ne 0 -and $type -ne 32768 -and $type -ne 16384){throw 'ZIP nonregular entry'}
  if(($entry.ExternalAttributes -band 1024) -ne 0){throw 'ZIP reparse entry'}
  $total+=$entry.Length
  if($total -gt 536870912 -or $zip.Entries.Count -gt 10000){throw 'ZIP expanded size limit'}
 }
 [IO.Compression.ZipFile]::ExtractToDirectory($env:OPL_KIMI_ZIP,$env:OPL_KIMI_DEST)
} finally {$zip.Dispose()}`,
    { OPL_KIMI_ZIP: archive, OPL_KIMI_DEST: destination },
  )
}

async function verifyInstallation(root, verifySignature) {
  const observedFiles = []
  async function checkRegularTree(path, relative = '') {
    const stat = await lstat(path)
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
      throw Error('KimiCU 安装目录包含链接或特殊文件')
    if (stat.isDirectory()) {
      for (const child of await readdir(path))
        await checkRegularTree(join(path, child), relative ? `${relative}/${child}` : child)
    } else observedFiles.push(relative)
  }
  await checkRegularTree(root)
  const pluginRoot = join(root, 'plugin')
  const executable = join(pluginRoot, 'runtime', 'node-repl.exe')
  const runtimeExecutable = join(root, 'runtime', 'kimi-cu.exe')
  const bundleBytes = await readFile(join(pluginRoot, 'bundle.json'))
  if (hash(bundleBytes) !== '823903608ce503721df9c11741c9df89cbb181beda1b81c6e2eb8c738417d190')
    throw Error('KimiCU 插件文件清单 SHA-256 不匹配')
  const bundle = JSON.parse(bundleBytes.toString('utf8'))
  const plugin = JSON.parse(await readFile(join(pluginRoot, 'kimi.plugin.json'), 'utf8'))
  if (
    bundle.version !== WINDOWS_KIMI_CU_VERSION ||
    plugin.version !== WINDOWS_KIMI_CU_VERSION ||
    plugin.name !== 'kimi-cu-win' ||
    plugin.mcpServers?.win?.command !== './runtime/node-repl.exe'
  )
    throw Error('KimiCU 插件版本或代码模式入口不匹配')
  if (!bundle.files || Object.keys(bundle.files).length === 0)
    throw Error('KimiCU 插件文件清单为空')
  const expectedFiles = new Set([
    'plugin/bundle.json',
    ...Object.keys(runtimeFiles).map((path) => `runtime/${path}`),
    ...Object.keys(bundle.files).map((path) => `plugin/${path}`),
  ])
  if (observedFiles.some((path) => !expectedFiles.has(path)))
    throw Error('KimiCU 安装目录包含清单以外的文件')
  for (const [path, expected] of Object.entries(bundle.files)) {
    validateWindowsKimiCuEntry(path)
    if (hash(await readFile(join(pluginRoot, path))) !== expected)
      throw Error(`KimiCU 插件文件 SHA-256 不匹配：${path}`)
  }
  for (const [path, expected] of Object.entries(runtimeFiles)) {
    if (hash(await readFile(join(root, 'runtime', path))) !== expected)
      throw Error(`KimiCU native runtime SHA-256 不匹配：${path}`)
  }
  await verifySignature(executable)
  await verifySignature(runtimeExecutable)
  return { pluginRoot, executable, runtimeExecutable, staticVerified: true, runtimeVerified: false }
}

/** Install into an OPL-owned version directory; preserve existing files and report static verification separately. */
export async function installWindowsKimiCu({
  suiteRoot,
  log = () => {},
  installRoot,
  nodeExecutable = process.execPath,
  fetchImpl = fetch,
  platform = process.platform,
  arch = process.arch,
  verifySignature = verifyWindowsKimiCuSignature,
  unpack = unpackWindowsKimiCu,
} = {}) {
  const record = async (result) => {
    if (suiteRoot) {
      await mkdir(suiteRoot, { recursive: true })
      await writeFile(
        join(suiteRoot, 'kimi-cu-installation.json'),
        JSON.stringify({ ...result, checkedAt: new Date().toISOString() }, null, 2) + '\n',
      )
    }
    return result
  }
  if (platform !== 'win32' || arch !== 'x64')
    return record({ state: 'skipped', reason: 'KimiCU Windows 需要 Windows x64' })
  let stage
  try {
    if (!isAbsolute(nodeExecutable)) throw Error('KimiCU 需要外部 Node.js 的绝对路径')
    const node = spawnSync(nodeExecutable, ['--version'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
    })
    const version = /^v(\d+)\.(\d+)\.(\d+)\s*$/u.exec(node.stdout ?? '')
    if (
      node.status !== 0 ||
      !version ||
      Number(version[1]) < 24 ||
      (Number(version[1]) === 24 && Number(version[2]) < 15)
    )
      throw Error('KimiCU 需要外部 Node.js 24.15.0 或更新版本')
    if (!installRoot && (!suiteRoot || !isAbsolute(suiteRoot)))
      throw Error('KimiCU 需要套件的绝对安装目录')
    const root = installRoot ?? join(suiteRoot, 'kimi-cu', WINDOWS_KIMI_CU_VERSION)
    if (!isAbsolute(root)) throw Error('KimiCU 安装目录必须为绝对路径')
    if (existsSync(root)) {
      const verified = await verifyInstallation(root, verifySignature)
      return record({ state: 'current', version: WINDOWS_KIMI_CU_VERSION, ...verified })
    }
    const manifest = windowsKimiCuRelease(
      JSON.parse((await download(WINDOWS_KIMI_CU_MANIFEST_URL, 65536, fetchImpl)).toString('utf8')),
    )
    await mkdir(dirname(root), { recursive: true })
    stage = await mkdtemp(join(dirname(root), '.opl-kimi-stage-'))
    for (const kind of ['plugin', 'runtime']) {
      const bytes = await download(manifest[kind].url, 256 * 1024 * 1024, fetchImpl)
      if (hash(bytes) !== hashes[kind]) throw Error(`KimiCU ${kind} 归档 SHA-256 不匹配`)
      const archive = join(stage, `${kind}.zip`)
      await writeFile(archive, bytes)
      await unpack(archive, join(stage, kind))
      await rm(archive)
    }
    await verifyInstallation(stage, verifySignature)
    await rename(stage, root)
    stage = undefined
    const verified = await verifyInstallation(root, verifySignature)
    log(`KimiCU Windows ${WINDOWS_KIMI_CU_VERSION} 文件已安装并静态校验；运行状态待单独验证`)
    return record({ state: 'installed', version: WINDOWS_KIMI_CU_VERSION, ...verified })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log(`KimiCU Windows 自动安装未完成：${message}`)
    return record({ state: 'deferred', message, staticVerified: false, runtimeVerified: false })
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true })
  }
}
