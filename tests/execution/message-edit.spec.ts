import { expect, it, vi } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createSystemMessage, createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionPromptRequest } from '@deepseek-ai/dsh-api-session-controller/types'
import {
  messageEditState,
  MessageEditTransactions,
  unresolvedMessageEdit,
} from '../../src/execution/host/message-edit.ts'
import type { EditIntent } from '../../src/execution/host/message-edit-store.ts'
import { messageEditMarker } from '../../src/execution/contracts/message-edit.ts'

function fixture() {
  const session = Session.create(SessionId('owned-message-edit'))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append(
    'system/message',
    { turn: 1, step: 1, message: createSystemMessage('instructions') },
    { surfaceOp: 'append' },
  )
  const original = session.append(
    'user/message',
    createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'original' }] }),
    { surfaceOp: 'append' },
  )
  const later = session.append(
    'user/message',
    createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'later' }] }),
    { surfaceOp: 'append' },
  )
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const prompt: SessionPromptRequest = {
    sessionId: session.id,
    requestId: 'owned-edit-request' as SessionPromptRequest['requestId'],
    mode: 'queue',
    content: [{ type: 'text', text: 'edited' }],
  }
  const input = { prompt, targetSeq: Number(original.seq), head: Number(session.seq) - 1 }
  const queued: UserMessage[] = []
  const agent = {
    id: session.id,
    session,
    status: 'idle',
    inbox: { nextTurn: queued, nextStep: [], remove: vi.fn() },
  } as unknown as Agent
  let record: EditIntent | undefined
  const store = {
    get: () => record,
    save: vi.fn(async (next: EditIntent) => {
      record = next
    }),
  }
  const edits = new MessageEditTransactions(store)
  const admit = vi.fn(async () => {
    queued.push(
      createUserMessage({
        source: { kind: 'user', rpcId: prompt.requestId },
        content: [{ type: 'text', text: 'edited' }],
      }),
    )
    return { accepted: true as const }
  })
  const commit = async (flush = async () => true) => {
    edits.claim(agent, queued, 2, 1)
    session.append('turn/start', { turn: 2 })
    session.append('step/start', { turn: 2, step: 1 })
    await edits.commit(agent, 2, 1, new AbortController().signal, flush)
  }
  const drain = () => session.append('user/message', queued[0]!, { surfaceOp: 'append' })
  return { session, input, agent, edits, store, admit, commit, drain, later }
}
it('selection and successful admission do not change history before the official request hook', async () => {
  const f = fixture()
  const before = f.session.seq
  messageEditState(f.session, false, true)
  expect(f.session.seq).toBe(before)
  await f.edits.send(f.agent, f.input, f.admit)
  expect(f.session.seq).toBe(before)
  expect(f.edits.pending(f.agent.id)).toBe(true)
})
it('first message replacement keeps identity, audit history and system input, removes later model input', async () => {
  const f = fixture()
  await f.edits.send(f.agent, f.input, f.admit)
  await f.commit()
  f.drain()
  expect(f.session.id).toBe('owned-message-edit')
  expect(f.session.deriveMessages().flatMap((message) => message.content)).toEqual([
    { type: 'text', text: 'instructions' },
    { type: 'text', text: 'edited' },
  ])
  expect(
    f.session
      .snapshotEvents()
      .some(
        (event) =>
          event.type === 'user/message' &&
          event.data.content[0]?.type === 'text' &&
          event.data.content[0].text === 'original',
      ),
  ).toBe(true)
  expect(unresolvedMessageEdit(f.session.snapshotEvents())).toBe(false)
  expect(messageEditState(f.session, false, true).choices.map((choice) => choice.text)).toEqual([
    'edited',
  ])
  const head = f.session.seq
  await f.edits.send(f.agent, f.input, f.admit)
  expect(f.session.seq).toBe(head)
  expect(f.admit).toHaveBeenCalledTimes(1)
  await expect(
    f.edits.send(f.agent, { ...f.input, targetSeq: Number(f.later.seq) }, f.admit),
  ).rejects.toThrow('身份')
})
it('later message replacement preserves earlier inputs', async () => {
  const f = fixture()
  f.input.targetSeq = Number(f.later.seq)
  await f.edits.send(f.agent, f.input, f.admit)
  await f.commit()
  f.drain()
  expect(
    f.session
      .deriveMessages()
      .flatMap((message) => message.content)
      .map((block) => (block.type === 'text' ? block.text : '')),
  ).toEqual(['instructions', 'original', 'edited'])
})
it.each(['stale', 'empty', 'steer'] as const)(
  'rejects %s before admission or history mutation',
  async (kind) => {
    const f = fixture()
    if (kind === 'stale') f.input.head--
    if (kind === 'empty')
      f.input.prompt = { ...f.input.prompt, content: [{ type: 'text', text: ' ' }] }
    if (kind === 'steer') f.input.prompt = { ...f.input.prompt, mode: 'steer' }
    const before = f.session.seq
    await expect(f.edits.send(f.agent, f.input, f.admit)).rejects.toThrow()
    expect(f.session.seq).toBe(before)
    expect(f.admit).not.toHaveBeenCalled()
  },
)
it('official admission failure cancels only the edit intent, keeping history intact', async () => {
  const f = fixture(),
    before = f.session.seq
  await expect(
    f.edits.send(f.agent, f.input, async () => {
      throw Error('rejected')
    }),
  ).rejects.toThrow('rejected')
  expect(f.session.seq).toBe(before)
  expect(f.edits.pending(f.agent.id)).toBe(false)
})
it('does not commit an unrelated or changed pre-step input', async () => {
  const f = fixture()
  await f.edits.send(f.agent, f.input, f.admit)
  expect(() => f.edits.claim(f.agent, [], 2, 1)).toThrow('确认')
  expect(() =>
    f.edits.claim(
      f.agent,
      [
        createUserMessage({
          source: { kind: 'user', rpcId: f.input.prompt.requestId },
          content: [{ type: 'text', text: 'different' }],
        }),
      ],
      2,
      1,
    ),
  ).toThrow('确认')
})
it('a failed flush blocks model continuation and cannot repeat replacement', async () => {
  const f = fixture()
  await f.edits.send(f.agent, f.input, f.admit)
  await expect(f.commit(async () => false)).rejects.toThrow('保存')
  expect(unresolvedMessageEdit(f.session.snapshotEvents())).toBe(true)
  const head = f.session.seq
  await expect(f.edits.send(f.agent, f.input, f.admit)).rejects.toThrow('确认')
  expect(f.session.seq).toBe(head)
})
it('refuses a changed surface after asynchronous admission', async () => {
  const f = fixture()
  await f.edits.send(f.agent, f.input, f.admit)
  f.session.append(
    'user/message',
    createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'intervening' }],
    }),
    { surfaceOp: 'append' },
  )
  await expect(f.commit()).rejects.toThrow('变化')
  expect(unresolvedMessageEdit(f.session.snapshotEvents())).toBe(false)
})
it('rejects damaged wire markers', () => {
  expect(
    messageEditMarker({ oplMessageEdit: { version: 1, start: 5, end: 2, requestId: 'id' } }),
  ).toBeUndefined()
})
