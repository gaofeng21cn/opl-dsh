/** Keep ACP unchanged while adapting OFM Chat tool-delta framing for the official CLI. */
import { spawn } from 'node:child_process'
import { startChatToolRelay } from './chat-tool-relay.ts'

const family = process.env.OPL_CHAT_CLI
if (family !== 'opencode' && family !== 'kilo') throw Error('Unknown Chat compatibility CLI')
const configKey = family === 'kilo' ? 'KILO_CONFIG_CONTENT' : 'OPENCODE_CONFIG_CONTENT'
const providerId = family === 'kilo' ? 'oplkilo' : 'oplopencode'
const config = JSON.parse(process.env[configKey]!)
const provider = config.provider[providerId]
const model = Object.keys(provider.models)
if (model.length !== 1) throw Error('Chat compatibility requires one selected model')
const relay = await startChatToolRelay({
  baseURL: provider.options.baseURL,
  apiKey: provider.options.apiKey,
  model: model[0]!,
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
process.stdin.pipe(child.stdin)
child.stdout.pipe(process.stdout)
let closing: Promise<void> | undefined
const exited = new Promise<void>((resolve) => {
  child.once('exit', () => resolve())
  child.once('error', () => resolve())
})
function stop() {
  return (closing ??= (async () => {
    await relay.close()
    child.stdin.end()
    if (child.exitCode === null && child.signalCode === null) {
      const timer = setTimeout(() => child.kill(), 1000)
      await exited
      clearTimeout(timer)
    }
  })())
}
child.on('error', () => {
  process.stdin.unpipe(child.stdin)
  process.stdin.destroy()
  void relay.close()
  process.exitCode = 1
})
child.stdin.on('error', () => {
  void stop()
})
child.once('exit', () => {
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
