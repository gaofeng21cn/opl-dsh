/**
 * Isolated operational probe against the **real** official MiMo Code CLI.
 *
 * This is the runnable form of the acceptance that `mimo-official.spec.ts` proves under
 * Vitest. It is intentionally self-contained: it imports nothing from the repository,
 * because plain `node` cannot load this suite's TypeScript. The suite's own evidence
 * path is the Vitest spec, which loads the adapter exactly as production does; this
 * script exists so the same run can be repeated in an isolated environment without the
 * test runner.
 *
 * Usage:
 *   node probe.mjs <work-dir> [path-to-mimo] [git-bash-path]
 *
 * Exit codes: 0 all checks passed, 1 a check failed, 2 the official CLI is missing,
 * 3 usage error.
 *
 * Scope, stated so it cannot be over-read: this proves the official protocol, the
 * official default shell tool, Git Bash, real `git` subprocesses, a non-ASCII working
 * directory, session load and cleanup. The model is a local keyless stub
 * this script controls, so it is **not** model-availability evidence and not OFM
 * acceptance. No account is read: the profile is redirected with the official
 * `MIMOCODE_HOME`, and `HOME` / `CODEX_HOME` are never redefined.
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { accessSync, constants, existsSync, mkdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const [, , workDirArg, binaryArg, bashArg] = process.argv
if (!workDirArg) {
  console.error('用法: node probe.mjs <work-dir> [path-to-mimo] [git-bash-path]')
  process.exit(3)
}
const OWNED = 'C:/Users/root/Documents/Codex/repair-20261013/ofm-harness-adaptation/mimo'
const binary = binaryArg ?? join(OWNED, 'official', 'mimo.exe')
const workDir = workDirArg.replace(/[\\/]+$/, '')
const cwd = join(workDir, '中文 项目 dir')
const profile = join(workDir, 'profile')

/** Same candidate order as the suite's `gitBashCandidates`, including the PATH scan. */
function resolveGitBash() {
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA,
  ].filter(Boolean)
  const candidates = [
    ...(process.env.OPL_GIT_BASH_PATH ? [process.env.OPL_GIT_BASH_PATH] : []),
    ...roots.flatMap((root) => [
      join(root, 'Git', 'bin', 'bash.exe'),
      join(root, 'Git', 'usr', 'bin', 'bash.exe'),
    ]),
    ...(process.env.PATH ?? '')
      .split(';')
      .filter(Boolean)
      .map((directory) => join(directory.trim(), 'bash.exe')),
  ]
  const found = [...new Set(candidates)].find((path) => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  })
  if (!found) throw new Error(`未找到 Git Bash：${candidates.join(', ')}`)
  return found
}

if (!existsSync(binary)) {
  console.error(`官方 MiMo Code CLI 未就绪：${binary}`)
  process.exit(2)
}
let gitBash
try {
  gitBash = bashArg ?? resolveGitBash()
  accessSync(gitBash, constants.X_OK)
} catch (error) {
  console.error(`Git Bash 不可用：${error.message}`)
  process.exit(2)
}

mkdirSync(cwd, { recursive: true })
mkdirSync(profile, { recursive: true })

const failures = []
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '[ok]  ' : '[FAIL]'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

// ---------------------------------------------------------------- controlled model
let turn = 0
const frame = (chunk) => `data: ${JSON.stringify(chunk)}${'\n\n'}`

const server = createServer((request, response) => {
  let raw = ''
  request.on('data', (chunk) => (raw += chunk))
  request.on('end', () => {
    const body = JSON.parse(raw || '{}')
    turn += 1
    const base = { id: `s${turn}`, object: 'chat.completion.chunk', created: 0, model: body.model }
    const shell = (body.tools ?? []).find(
      (t) => t?.function?.name && /bash|shell|terminal/i.test(t.function.name),
    )
    // The CLI requests streaming, and advertises the shell tool only from the second
    // turn on; both are read from the request instead of assumed. The tool is issued at
    // most twice so a failing tool cannot spin the turn forever.
    const sse =
      shell && turn <= 3
        ? frame({
            ...base,
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call-1',
                      type: 'function',
                      function: { name: shell.function.name, arguments: '' },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          }) +
          frame({
            ...base,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: shellArguments(shell) } }],
                },
                finish_reason: null,
              },
            ],
          }) +
          frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
        : frame({
            ...base,
            choices: [
              { index: 0, delta: { role: 'assistant', content: '继续' }, finish_reason: null },
            ],
          }) +
          frame({
            ...base,
            choices: [{ index: 0, delta: { content: '已完成' }, finish_reason: 'stop' }],
          })
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    response.end(`${sse}data: [DONE]${'\n\n'}`)
  })
})

const COMMAND =
  'mkdir -p 子目录 && printf 你好 > 子目录/说明.txt && uname -s > ev-uname.txt ' +
  '&& git init -q && git rev-parse --is-inside-work-tree > ev-git.txt && which bash > ev-bash.txt'

/** Fill every field the tool's own schema declares as required. */
function shellArguments(shell) {
  const schema = shell.function?.parameters ?? {}
  const required = Array.isArray(schema.required) ? schema.required : []
  const properties = Object.keys(schema.properties ?? {})
  const commandKey = properties.find((name) => /command|cmd|script/i.test(name)) ?? 'command'
  const args = {}
  for (const name of required) args[name] = /command|cmd|script/i.test(name) ? COMMAND : 'probe'
  if (args[commandKey] === undefined) args[commandKey] = COMMAND
  return JSON.stringify(args)
}

await new Promise((done) => server.listen(0, '127.0.0.1', done))
const port = server.address().port

const config = JSON.stringify({
  $schema: 'https://mimo.xiaomi.com/mimocode/config.json',
  model: 'oplmimo/probe-model',
  provider: {
    oplmimo: {
      name: 'OPL Route',
      npm: '@ai-sdk/openai-compatible',
      only_configured_models: true,
      models: { 'probe-model': { name: 'probe-model' } },
      options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'probe-key-not-a-secret' },
    },
  },
})

// ------------------------------------------------------------------- official CLI
// The environment the suite composes: an allow-list plus Git Bash plus the official
// profile override. HOME and CODEX_HOME are carried through untouched, never redefined.
const KEYS = [
  'PATH',
  'HOME',
  'CODEX_HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TERM',
  'SHELL',
  'USER',
  'LOGNAME',
]
const env = {}
for (const key of KEYS) if (process.env[key]) env[key] = process.env[key]

const child = spawn(binary, ['acp', '--cwd', cwd], {
  cwd,
  env: {
    ...env,
    MIMOCODE_HOME: profile,
    MIMOCODE_CONFIG_CONTENT: config,
    SHELL: gitBash,
    MIMOCODE_GIT_BASH_PATH: gitBash,
    MIMOCODE_DISABLE_AUTOUPDATE: 'true',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
})
child.stderr.resume()

let sequence = 0
const pending = new Map()
const timers = new Set()
const send = (message) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
const request = (method, params, ms = 180_000) =>
  new Promise((done, failed) => {
    const id = ++sequence
    const timer = setTimeout(() => {
      timers.delete(timer)
      pending.delete(id)
      failed(new Error(`${method} 超时`))
    }, ms)
    timers.add(timer)
    pending.set(id, { done, failed, timer })
    send({ id, method, params })
  })

const approvals = new Set()
createInterface({ input: child.stdout }).on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.id !== undefined && pending.has(message.id)) {
    const waiter = pending.get(message.id)
    clearTimeout(waiter.timer)
    timers.delete(waiter.timer)
    pending.delete(message.id)
    return message.error
      ? waiter.failed(new Error(message.error.message))
      : waiter.done(message.result)
  }
  // If the CLI asks the client to approve a tool, the probe stops without answering it; this is not an approval test.
  if (message.method === 'session/request_permission' && !approvals.has(message.id)) {
    approvals.add(message.id)
    failures.push('unexpected permission request; not answered')
    child.stdin.end()
  }
})

// ---------------------------------------------------------------------- the checks
try {
  const agent = await request('initialize', { protocolVersion: 1, clientCapabilities: {} })
  check(agent.protocolVersion === 1, 'initialize 协议版本 1', JSON.stringify(agent.agentInfo))
  check(agent.agentCapabilities?.loadSession === true, '广告 loadSession')

  const created = await request('session/new', { cwd, mcpServers: [] })
  const advertised = (created.configOptions ?? []).find((option) => option.id === 'model')
  check(
    advertised?.options?.some((option) => option.value === 'oplmimo/probe-model'),
    'session/new 广告本套件模型',
    JSON.stringify(advertised?.options?.map((option) => option.value)),
  )

  const pinned = await request('session/set_config_option', {
    sessionId: created.sessionId,
    configId: 'model',
    value: 'oplmimo/probe-model',
  })
  const current = (pinned.configOptions ?? []).find((option) => option.id === 'model')?.currentValue
  check(current === 'oplmimo/probe-model', '模型固定回读一致', String(current))

  const result = await request('session/prompt', {
    sessionId: created.sessionId,
    prompt: [{ type: 'text', text: '用默认 shell 工具验证 Git Bash、git 与中文空格读写' }],
  })
  check(result.stopReason === 'end_turn', 'prompt 正常结束', JSON.stringify(result.stopReason))

  const uname = await readFile(join(cwd, 'ev-uname.txt'), 'utf8').catch(() => '')
  check(/MINGW|MSYS/.test(uname), '官方 shell 工具运行在 Git Bash', uname.trim())
  const gitOut = await readFile(join(cwd, 'ev-git.txt'), 'utf8').catch(() => '')
  check(gitOut.includes('true'), '官方 shell 工具执行真实 git 外部命令', gitOut.trim())
  const bashOut = await readFile(join(cwd, 'ev-bash.txt'), 'utf8').catch(() => '')
  check(/bash/.test(bashOut), 'shell 解析到 bash', bashOut.trim())
  check(existsSync(join(cwd, '子目录', '说明.txt')), '中文加空格路径读写成功')
  check(existsSync(join(cwd, '.git')), '中文加空格目录内创建真实 git 仓库')

  const loaded = await request('session/load', {
    cwd,
    mcpServers: [],
    sessionId: created.sessionId,
  })
  check(
    typeof loaded.sessionId === 'string' && loaded.sessionId.length > 0,
    'session/load 恢复成功',
    loaded.sessionId,
  )

  for (const part of ['config', 'data', 'state'])
    check(existsSync(join(profile, part)), `MIMOCODE_HOME 隔离落在套件目录 (${part})`)

  console.log(`[info] 审批请求次数 ${approvals.size}`)
  console.log(`[info] Git Bash ${gitBash}`)
} catch (error) {
  failures.push(String(error))
  console.error(`[FAIL] ${error.message}`)
}

// ---------------------------------------------------------------- deterministic cleanup
for (const timer of timers) clearTimeout(timer)
timers.clear()
for (const waiter of pending.values()) waiter.failed(new Error('probe cleanup'))
pending.clear()
child.stdin.end()
const exited = new Promise((done) => child.once('exit', done))
const killTimer = setTimeout(() => child.kill(), 10_000)
await exited
clearTimeout(killTimer)
await new Promise((done) => server.close(() => done()))

if (failures.length) {
  console.error(`\n[FAIL] ${failures.length} 项未通过：${failures.join('、')}`)
  process.exit(1)
}
console.log('\n[PASS] 官方协议与工具证据全部通过；模型为本地无凭据 stub，不是联网 OFM 模型证据。')
console.log(`       隔离目录 ${workDir}`)
process.exit(0)
