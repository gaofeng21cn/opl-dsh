/** Keep ACP unchanged while adapting OFM Chat tool-delta framing for the official CLI. */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { startChatToolRelay } from './chat-tool-relay.ts'

const family = process.env.OPL_CHAT_CLI
if (family !== 'opencode' && family !== 'kilo') throw Error('Unknown Chat compatibility CLI')
const configKey = family === 'kilo' ? 'KILO_CONFIG_CONTENT' : 'OPENCODE_CONFIG_CONTENT'
const providerId = family === 'kilo' ? 'oplkilo' : 'oplopencode'
const config = JSON.parse(process.env[configKey]!)
const provider = config.provider[providerId]
const model = Object.keys(provider.models)
if (model.length !== 1) throw Error('Chat compatibility requires one selected model')
let reportUpstreamFailure: ((status?: number) => void) | undefined
const relay = await startChatToolRelay({
  baseURL: provider.options.baseURL,
  apiKey: provider.options.apiKey,
  model: model[0]!,
  onUpstreamFailure: (status) => reportUpstreamFailure?.(status),
})
provider.options.baseURL = relay.baseURL
provider.options.apiKey = relay.key
const env = { ...process.env, [configKey]: JSON.stringify(config) }
const command = process.env.OPL_CHAT_COMMAND!
const args = JSON.parse(process.env.OPL_CHAT_ARGS!) as string[]
const verbatim = process.env.OPL_CHAT_VERBATIM === '1'
for (const key of [
  'ELECTRON_RUN_AS_NODE',
  'OPL_CHAT_CLI',
  'OPL_CHAT_COMMAND',
  'OPL_CHAT_ARGS',
  'OPL_CHAT_VERBATIM',
])
  delete env[key]
const child = spawn(command, args, {
  env,
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
  ...(verbatim ? { windowsVerbatimArguments: true } : {}),
})
child.stderr.resume()
const promptIds = new Map<string, number>()
let upstreamFailed = false
const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
const output = createInterface({ input: child.stdout, crlfDelay: Infinity })
input.on('line', (line) => {
  if (upstreamFailed) return
  try {
    const message = JSON.parse(line) as {
      id?: unknown
      method?: unknown
      params?: { sessionId?: unknown }
    }
    if (
      message.method === 'session/prompt' &&
      typeof message.id === 'number' &&
      typeof message.params?.sessionId === 'string'
    )
      promptIds.set(message.params.sessionId, message.id)
  } catch {
    // The official ACP transport owns validation; this bridge only forwards the line.
  }
  if (!child.stdin.destroyed) child.stdin.write(line + '\n')
})
output.on('line', (line) => {
  if (upstreamFailed) return
  process.stdout.write(line + '\n')
  try {
    const message = JSON.parse(line) as { id?: unknown; method?: unknown }
    if (message.method === undefined && typeof message.id === 'number') {
      for (const [sessionId, promptId] of promptIds)
        if (promptId === message.id) promptIds.delete(sessionId)
    }
  } catch {
    // Forwarding remains lossless even if a CLI writes a non-JSON diagnostic line.
  }
})
let closing: Promise<void> | undefined
const exited = new Promise<void>((resolve) => {
  child.once('exit', () => resolve())
  child.once('error', () => resolve())
})
function stop() {
  return (closing ??= (async () => {
    input.close()
    await relay.close()
    child.stdin.end()
    if (child.exitCode === null && child.signalCode === null) {
      const timer = setTimeout(() => child.kill(), 1000)
      await exited
      clearTimeout(timer)
    }
  })())
}
const upstreamCode = (status?: number): string =>
  status === undefined
    ? 'HARNESS_PROVIDER_NETWORK'
    : status === 401 || status === 403
      ? 'HARNESS_PROVIDER_AUTH'
      : status === 404
        ? 'HARNESS_PROVIDER_MODEL'
        : status === 408 || status === 504
          ? 'HARNESS_PROVIDER_TIMEOUT'
          : status === 429
            ? 'HARNESS_PROVIDER_RATE_LIMIT'
            : 'HARNESS_PROVIDER'
reportUpstreamFailure = (status) => {
  if (upstreamFailed) return
  upstreamFailed = true
  const code = upstreamCode(status)
  for (const promptId of new Set(promptIds.values()))
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: promptId,
        error: {
          code,
          message: '官方渠道请求未完成',
          data: { service: 'session', ...(status === undefined ? {} : { httpStatus: status }) },
        },
      }) + '\n',
    )
  promptIds.clear()
  void stop()
}
child.on('error', () => {
  input.close()
  void relay.close()
  process.exitCode = 1
})
child.stdin.on('error', () => {
  void stop()
})
child.once('exit', () => {
  input.close()
  output.close()
  void relay.close().then(() => process.exit(child.exitCode ?? 1))
})
process.stdin.once('end', () => {
  void stop()
})
process.once('SIGTERM', () => {
  void stop()
})
process.once('SIGINT', () => {
  void stop()
})
