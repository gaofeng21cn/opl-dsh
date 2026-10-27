import { expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { HarnessSession } from '../../../src/execution/contracts/sessions.ts'
import {
  externalEditChoices,
  externalEditedRecord,
} from '../../../src/execution/host/message-edit-mapping.ts'
function setup() {
  const record = {
    id: 'record',
    nativeSessionId: 'dsh',
    acpSessionId: 'vendor',
    turns: [
      { operationId: 'one', prompt: 'same', native: { userMessageId: 'a', officialSeq: 1 } },
      { operationId: 'two', prompt: 'same', native: { userMessageId: 'b', officialSeq: 2 } },
    ],
  } as HarnessSession
  const events = [1, 2].map((seq) => ({
    type: 'user/message',
    seq,
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'same' }] },
  })) as unknown as SessionEvent[]
  const history = { sessionId: 'vendor', token: 'token', boundaries: [{ id: 'a' }, { id: 'b' }] }
  return { record, events, history, active: new Set([1, 2]) }
}
it('matches repeated text using exact official and vendor identities', () => {
  const s = setup()
  expect(
    externalEditChoices(s.record, s.history, s.events, s.active).map((x) => [x.seq, x.boundaryId]),
  ).toEqual([
    [1, 'a'],
    [2, 'b'],
  ])
})
it('does not infer an unbound turn from equal text or matching counts', () => {
  const s = setup()
  delete s.record.turns[0]!.native
  expect(
    externalEditChoices(s.record, s.history, s.events, s.active).map((x) => x.boundaryId),
  ).toEqual(['b'])
})
it('does not expose superseded official events or duplicate identities', () => {
  const s = setup()
  s.active.delete(1)
  expect(externalEditChoices(s.record, s.history, s.events, s.active).map((x) => x.seq)).toEqual([
    2,
  ])
  s.record.turns[0]!.native!.userMessageId = 'b'
  expect(externalEditChoices(s.record, s.history, s.events, s.active)).toEqual([])
})
it('rebinds only a verified prefix while keeping the DSH identity and original record', () => {
  const s = setup()
  const before = structuredClone(s.record)
  const next = externalEditedRecord(s.record, s.history, 'b', {
    sessionId: 'child',
    retained: [{ previousId: 'a', nextId: 'remapped' }],
  })
  expect(next.nativeSessionId).toBe('dsh')
  expect(next.acpSessionId).toBe('child')
  expect(next.turns).toHaveLength(1)
  expect(next.turns[0]!.native).toEqual({ userMessageId: 'remapped', officialSeq: 1 })
  expect(s.record).toEqual(before)
})
it('refuses a backend prefix that does not cover the stored turns', () => {
  const s = setup()
  s.record.turns[0]!.native!.userMessageId = 'other'
  expect(() =>
    externalEditedRecord(s.record, s.history, 'b', {
      sessionId: 'child',
      retained: [{ previousId: 'a', nextId: 'new' }],
    }),
  ).toThrow('映射不一致')
})
