/** ACP fixture that records methods and advertises only the requested thinking values. */
import { createInterface } from 'node:readline'
import { appendFileSync } from 'node:fs'
const options = [
  { id: 'model', currentValue: 'fixture', options: [{ value: 'fixture' }] },
  { id: 'thinking', currentValue: 'on', options: [{ value: 'off' }, { value: 'on' }] },
]
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  appendFileSync(process.env.PROBE_METHODS, message.method + '\n')
  const result =
    message.method === 'initialize'
      ? { protocolVersion: 1 }
      : message.method === 'session/new'
        ? { sessionId: 'probe', configOptions: options }
        : message.method === 'session/set_config_option'
          ? { configOptions: options }
          : undefined
  process.stdout.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      ...(result ? { result } : { error: { code: -32601 } }),
    }) + '\n',
  )
})
