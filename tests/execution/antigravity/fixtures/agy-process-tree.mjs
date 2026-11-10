import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') send({ id: message.id, result: { protocolVersion: 1 } })
  else if (message.method === 'session/new')
    send({ id: message.id, result: { sessionId: 'owned-tree-session' } })
  else if (message.method === 'session/prompt') {
    const tool = spawn(
      process.execPath,
      ['-e', "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)"],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    )
    tool.once('message', () => {
      tool.disconnect()
      tool.unref()
      send({
        method: 'session/update',
        params: {
          sessionId: 'owned-tree-session',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: JSON.stringify({ leader: process.pid, tool: tool.pid }),
            },
          },
        },
      })
      if (message.params.prompt[0].text === 'leader-exit') process.exit(1)
    })
  } else if (message.id !== undefined) send({ id: message.id, result: {} })
})
