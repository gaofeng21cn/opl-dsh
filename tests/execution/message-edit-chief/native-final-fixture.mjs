import { build } from 'esbuild'
import { createServer } from 'node:http'
import { execFileSync, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const repo = 'C:/Users/root/Documents/Codex/repair-20261013/post-pr-features/repo'
const lane =
  'C:/Users/root/Documents/Codex/repair-20261026/harness-message-edit/native-engines/chief-final-bash-bridge'
const codex =
  'C:/Users/root/.dsh/profiles/desktop/harness-runtimes/codex/0.160.1-opl-gitbash.20261012.2/bin/codex.exe'
const claude = 'C:/Users/root/.local/bin/claude'
const home = join(lane, 'home')
const work = join(lane, 'work')
const bundle = join(lane, 'bridge.mjs')
// Chief evidence is retained; this directory is exclusive.
await mkdir(home, { recursive: true })
await mkdir(join(home, 'codex'), { recursive: true })
await mkdir(join(home, 'claude'), { recursive: true })
await mkdir(work, { recursive: true })
const built = await build({
  entryPoints: [join(repo, 'src/execution/host/adapters/native-harness-bridge.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  write: false,
  absWorkingDir: repo,
  logLevel: 'silent',
})
await writeFile(bundle, built.outputFiles[0].text)

const sse = (text) =>
  [
    `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: 'resp-1' } })}\n\n`,
    `event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: 'msg-1', content: [{ type: 'output_text', text }] } })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp-1' } })}\n\n`,
  ].join('')

const requests = []
let delayMs = 0
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => (body += chunk))
  req.on('end', () => {
    try {
      const parsed = JSON.parse(body || '{}')
      requests.push(parsed)
    } catch {
      requests.push({ raw: body })
    }
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(sse('mock answer'))
    }, delayMs)
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

function client(child) {
  const lines = createInterface({ input: child.stdout })
  const pending = new Map()
  let seq = 0
  lines.on('line', (line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject, timer } = pending.get(message.id)
      clearTimeout(timer)
      pending.delete(message.id)
      message.error ? reject(new Error(message.error.code)) : resolve(message.result)
    }
  })
  return (method, params, timeout = 30_000) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`timeout ${method}`))
      }, timeout)
      pending.set(id, { resolve, reject, timer })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
}

async function start(kind) {
  const env = {
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    COMSPEC: process.env.COMSPEC,
    PATHEXT: process.env.PATHEXT,
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    TEMP: lane,
    TMP: lane,
    NO_PROXY: '*',
    no_proxy: '*',
    OPL_NATIVE_HARNESS: kind,
    OPL_NATIVE_COMMAND: kind === 'codex' ? codex : claude,
    OPL_NATIVE_MODEL: kind === 'codex' ? 'gpt-5.5' : 'claude-sonnet-4-5-20250929',
    OPL_NATIVE_PERMISSION: 'full-access',
    OPL_NATIVE_BASE_URL: `http://127.0.0.1:${port}/v1`,
    OPL_NATIVE_API_KEY: 'mock-not-a-real-key',
    OPL_NATIVE_DIAGNOSTICS: '1',
    CODEX_HOME: join(home, 'codex'),
    CLAUDE_CONFIG_DIR: join(home, 'claude'),
  }
  if (kind === 'codex') {
    env.PATH = `${join(codex, '..')};${env.PATH}`
    env.OPL_NATIVE_CODEX_GIT_BASH = '1'
    env.OPL_NATIVE_GIT_BASH = String.raw`C:\Program Files\Git\bin\bash.exe`
  }
  const child = spawn(process.execPath, [bundle], {
    cwd: work,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stderr = []
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)))
  child.on('exit', (code) => stderr.push(`exit:${code}`))
  const call = client(child)
  try {
    await call('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'opl-bridge-fixture', version: '0' },
    })
  } catch (error) {
    throw new Error(`${error?.message ?? error} stderr=${stderr.join('').slice(-2000)}`)
  }
  return { child, call, stderr }
}

function userTexts(body) {
  const input = body?.input
  if (!Array.isArray(input)) return []
  return input
    .flatMap((item) =>
      item?.role === 'user' && Array.isArray(item.content)
        ? item.content.filter((part) => part?.type === 'input_text').map((part) => part.text)
        : [],
    )
    .filter((text) => !String(text).startsWith('<environment_context>'))
}

async function stop(child) {
  try {
    child.stdin.end()
  } catch {}
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve()
    const timer = setTimeout(() => {
      child.kill()
      resolve()
    }, 2000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

const out = { codex: {}, claude: {} }
let codexStderr = []
try {
  const { child, call, stderr } = await start('codex')
  codexStderr = stderr
  try {
    out.codex.step = 'session/new'
    const created = await call('session/new', { cwd: work, mcpServers: [] })
    const sessionId = created.sessionId
    out.codex.sessionId = sessionId
    out.codex.step = 'prompt-first'
    delayMs = 800
    const firstPrompt = call('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'first' }],
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    out.codex.step = 'busy-read'
    try {
      await call('opl/message-edit/read', { sessionId }, 5000)
      out.codex.busy = 'resolved'
    } catch (error) {
      out.codex.busy = String(error?.message ?? error)
    }
    await firstPrompt
    delayMs = 0
    out.codex.step = 'prompt-second'
    await call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'second' }] })
    out.codex.step = 'read-before'
    const before = await call('opl/message-edit/read', { sessionId })
    out.codex.before = before
    out.codex.target = before.boundaries[1]?.id
    const target = before.boundaries[1].id
    out.codex.step = 'rewind'
    const result = await call('opl/message-edit/rewind', {
      sessionId,
      operationId: 'op-1',
      targetId: target,
      expectedToken: before.token,
    })
    out.codex.rewind = result
    out.codex.step = 'prompt-third'
    await call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'third' }] })
    const after = await call('opl/message-edit/read', { sessionId })
    out.codex.after = after
    if (before.boundaries.length !== 2 || after.boundaries.length !== 2)
      throw Error('internal Git Bash probe changed user boundary count')
    out.codex.firstRewind = await call('opl/message-edit/rewind', {
      sessionId,
      operationId: 'op-first',
      targetId: after.boundaries[0].id,
      expectedToken: after.token,
    })
    if (out.codex.firstRewind.retained.length !== 0) throw Error('first edit retained a user input')
    await call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'fourth' }] })
    out.codex.firstAfter = await call('opl/message-edit/read', { sessionId })
    if (out.codex.firstAfter.boundaries.length !== 1)
      throw Error('first edit did not replace history')
    out.codex.requests = requests.map(userTexts)
    out.codex.stderr = stderr.join('').slice(-3000)
    // Kill the Codex app-server child (not the bridge) to exercise a real read failure.
    try {
      const pids = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${child.pid}").ProcessId`,
        ],
        { encoding: 'utf8' },
      )
        .trim()
        .split(/\s+/)
        .filter(Boolean)
      for (const pid of pids)
        execFileSync('taskkill.exe', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' })
      await new Promise((resolve) => setTimeout(resolve, 300))
      try {
        await call('opl/message-edit/read', { sessionId }, 5000)
        out.codex.readFailure = 'resolved'
      } catch (error) {
        out.codex.readFailure = String(error?.message ?? error)
      }
    } catch (error) {
      out.codex.readFailureFixture = String(error?.message ?? error)
    }
  } finally {
    await stop(child)
  }
} catch (error) {
  out.codex.error = String(error?.message ?? error)
  out.codex.stderr = codexStderr.join('').slice(-4000)
}

try {
  const { child, call, stderr } = await start('claude')
  try {
    const claudeHome = join(home, 'claude')
    const project = join(claudeHome, 'projects', 'probe')
    await mkdir(project, { recursive: true })
    const sessionId = randomUUID()
    const u1 = randomUUID()
    const entries = [
      {
        type: 'user',
        uuid: u1,
        parentUuid: null,
        sessionId,
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'first' },
      },
      {
        type: 'assistant',
        uuid: randomUUID(),
        parentUuid: u1,
        sessionId,
        timestamp: new Date().toISOString(),
        message: { role: 'assistant', content: [{ type: 'text', text: 'reply1' }] },
      },
    ]
    await writeFile(
      join(project, sessionId + '.jsonl'),
      entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
    )
    const loaded = await call('session/load', { sessionId, cwd: work, mcpServers: [] })
    out.claude.loaded = loaded
    out.claude.step = 'read-before'
    const before = await call('opl/message-edit/read', { sessionId })
    out.claude.before = before
    out.claude.step = 'rewind'
    const result = await call('opl/message-edit/rewind', {
      sessionId,
      operationId: 'op-claude-first',
      targetId: before.boundaries[0].id,
      expectedToken: before.token,
    })
    out.claude.firstRewind = result
    const rebound = await call('session/load', {
      sessionId: result.sessionId,
      cwd: work,
      mcpServers: [],
    })
    out.claude.rebound = rebound
    out.claude.stderr = stderr.join('').slice(-2000)
  } finally {
    await stop(child)
  }
} catch (error) {
  out.claude.error = String(error?.message ?? error)
}
server.closeAllConnections?.()
server.close()
setTimeout(() => process.exit(out.codex.error || out.claude.error ? 1 : 0), 50)
console.log(JSON.stringify(out, null, 2))
