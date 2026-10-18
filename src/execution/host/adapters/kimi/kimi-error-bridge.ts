/** Transparent ACP forwarding; preserves provider failures omitted by Kimi's ACP end_turn. */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { commandLaunch } from '../../harness-registry.ts'
import { startKimiErrorRelay } from './kimi-error-relay.ts'

const relay = await startKimiErrorRelay({
  baseURL: process.env.KIMI_MODEL_BASE_URL!,
  apiKey: process.env.KIMI_MODEL_API_KEY!,
  model: process.env.KIMI_MODEL_NAME!,
})
const launch = commandLaunch(
  process.env.OPL_KIMI_COMMAND!,
  JSON.parse(process.env.OPL_KIMI_ARGS ?? '["acp"]') as string[],
)
const env: NodeJS.ProcessEnv = {
  ...process.env,
  KIMI_MODEL_BASE_URL: relay.baseURL,
  KIMI_MODEL_API_KEY: relay.key,
}
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(launch.command, launch.args, {
  env,
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
  ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
})
child.stderr.resume()
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n')
let promptId: string | number | undefined
let stopping: Promise<void> | undefined
const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
function stop() {
  return (stopping ??= (async () => {
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
  void relay.close()
  process.exitCode = 1
})
child.stdin.on('error', () => {
  void stop()
})
child.once('exit', () => {
  void relay.close().then(() => process.exit(child.exitCode ?? 1))
})
const input = createInterface({ input: process.stdin })
input.on('line', (line) => {
  try {
    const value = JSON.parse(line)
    if (value.method === 'session/prompt') {
      if (promptId !== undefined) {
        send({
          jsonrpc: '2.0',
          id: value.id,
          error: { code: -32600, message: 'Prompt already active' },
        })
        return
      }
      relay.begin()
      promptId = value.id
    }
    if (value.method === 'session/cancel') relay.cancel()
    child.stdin.write(line + '\n')
  } catch {
    /* Invalid ACP input is not forwarded as a model request. */
  }
})
createInterface({ input: child.stdout }).on('line', (line) => {
  try {
    const value = JSON.parse(line)
    if (promptId !== undefined && value.id === promptId && value.method === undefined) {
      const code = relay.end()
      promptId = undefined
      if (code && value.result?.stopReason !== 'cancelled') {
        send({ jsonrpc: '2.0', id: value.id, error: { code, message: 'Provider request failed' } })
        return
      }
    }
    send(value)
  } catch {
    /* Non-protocol CLI output is not exposed to the conversation. */
  }
})
input.once('close', () => {
  void stop()
})
process.once('SIGTERM', () => {
  void stop()
})
process.once('SIGINT', () => {
  void stop()
})
