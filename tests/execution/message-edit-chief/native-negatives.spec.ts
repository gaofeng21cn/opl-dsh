import { expect, it } from 'vitest'
import { grokMessageEditDriver } from '../../../src/execution/host/message-edit-grok.ts'
import type { ExternalEditContext } from '../../../src/execution/host/message-edit-driver.ts'
import type { HarnessSession } from '../../../src/execution/contracts/sessions.ts'

function fixture() {
  const abort = new AbortController()
  const record = {
    id: 'r',
    nativeSessionId: 'dsh',
    acpSessionId: 'grok',
    turns: [{ prompt: 'same', tools: [], native: { userMessageId: '0' } }],
  } as unknown as HarnessSession
  let abortOnRead = false
  let mutations = 0
  const context: ExternalEditContext = {
    record,
    signal: abort.signal,
    launch: { home: '/fixture', command: 'fixture', args: [], env: {} },
    snapshot: () => ({ agent: {}, session: {}, configOptions: [] }),
    disconnect: async () => {},
    reconnect: async () => {},
    transport: () => ({
      request: async (method) => {
        if (method === '_x.ai/rewind/points') {
          if (abortOnRead) abort.abort()
          return { rewind_points: [{ prompt_index: 0, prompt_preview: 'same' }] }
        }
        mutations++
        return {
          success: true,
          target_prompt_index: 0,
          mode: 'conversation_only',
          prompt_text: 'same',
        }
      },
    }),
  }
  return {
    context,
    record,
    abortDuringRead: () => {
      abortOnRead = true
    },
    mutations: () => mutations,
  }
}
it('does not mutate Grok after cancellation during the history await', async () => {
  const f = fixture()
  const expected = await grokMessageEditDriver.read(f.context)
  f.abortDuringRead()
  await expect(
    grokMessageEditDriver.rewind(f.context, { operationId: 'edit', targetId: '0', expected }),
  ).rejects.toThrow()
  expect(f.mutations()).toBe(0)
})
it('does not invent Grok boundaries solely from same-sized local history', async () => {
  const f = fixture()
  delete f.record.turns[0]!.native
  await expect(grokMessageEditDriver.read(f.context)).rejects.toThrow()
})
