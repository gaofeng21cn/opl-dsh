// Run one complete watcher audit in a fresh process against the test's durable state.
import { join } from 'node:path'
import { Coordinator } from '../../installer/skill/coordinator/runtime.mjs'

const [root, pid] = process.argv.slice(2)
const controller = new AbortController()
const sent = []
const runtime = new Coordinator({
  root: join(root, 'coordinator'),
  codexHome: join(root, 'codex'),
  controlPath: join(root, 'control.mjs'),
  queue: { transport: 'codex-queue' },
  inspect: async () => {
    try {
      process.kill(Number(pid), 0)
      return { status: 'alive' }
    } catch (error) {
      if (error.code === 'ESRCH') return { status: 'exited' }
      throw error
    }
  },
  waitExit: async () => ({ status: 'unknown' }),
  feedback: async () => ({
    status: 'available',
    observations: [],
    events: [],
    pending: [],
    consumed: [],
  }),
  send: async ({ intent }) => {
    sent.push(intent)
    return { status: 'accepted' }
  },
})
const reconcile = runtime.reconcile.bind(runtime)
runtime.reconcile = async (...args) => {
  const result = await reconcile(...args)
  controller.abort()
  return result
}
await runtime.watch({ signal: controller.signal })
process.stdout.write(JSON.stringify(sent))
