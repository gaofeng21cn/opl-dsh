import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HarnessSession } from '../../src/execution/contracts/sessions.ts'
import type { ExternalEditContext } from '../../src/execution/host/message-edit-driver.ts'
import { readStoredKiloHistory } from '../../src/execution/host/message-edit-kilo.ts'
import {
  ExternalMessageEditError,
  type StartVendorControl,
  type VendorMessage,
} from '../../src/execution/host/message-edit-opencode-common.ts'

function record(): HarnessSession {
  return {
    id: 'record-removed-model',
    combination: 'removed-model/kilo',
    harnessRef: 'kilo',
    modelRef: { provider: 'removed-source', model: 'removed-model' },
    cwd: '/stored-project',
    acpSessionId: 'ses_stored',
    nativeSessionId: 'dsh-stored',
    origin: { kind: 'desktop', sessionId: 'dsh-stored' },
    title: 'stored history',
    sandbox: 'full-access',
    createdAt: '2026-11-11T00:00:00.000Z',
    updatedAt: '2026-11-11T00:00:00.000Z',
    turns: [
      {
        operationId: 'initial',
        fingerprint: 'stored-request',
        prompt: 'hello',
        text: 'reply',
        state: 'completed',
        tools: [],
        native: { userMessageId: 'msg_input', officialSeq: 42 },
      },
    ],
  }
}

function messages(): VendorMessage[] {
  return [
    {
      info: {
        id: 'msg_input',
        role: 'user',
        sessionID: 'ses_stored',
        time: { created: 1 },
      },
      parts: [
        {
          id: 'prt_input',
          type: 'text',
          text: 'hello',
          messageID: 'msg_input',
          sessionID: 'ses_stored',
        },
      ],
    },
    {
      info: {
        id: 'msg_reply',
        role: 'assistant',
        sessionID: 'ses_stored',
        parentID: 'msg_input',
        time: { created: 2, completed: 3 },
        finish: 'stop',
      },
      parts: [],
    },
  ]
}

function controlFixture() {
  const calls: string[] = []
  let observed: ExternalEditContext | undefined
  let history = messages()
  const start: StartVendorControl = async (context) => {
    observed = context
    calls.push('start')
    return {
      async readStatus(id) {
        calls.push(`status:${id}`)
        return 'idle'
      },
      async readMessages(id) {
        calls.push(`read:${id}`)
        return structuredClone(history)
      },
      async readProviders() {
        throw new Error('model catalog must not be read')
      },
      async fork() {
        throw new Error('history reads must not fork')
      },
      async close() {
        calls.push('closed')
      },
    }
  }
  return {
    start,
    calls,
    context: () => observed!,
    replaceHistory(value: VendorMessage[]) {
      history = value
    },
  }
}

const options = { home: '/suite-profile', command: process.execPath }

describe('stored Kilo history without model admission', () => {
  it('reads a removed source and model using the same profile without credentials', async () => {
    const fixture = controlFixture()
    const session = record()
    const before = structuredClone(session)
    const history = await readStoredKiloHistory(
      session,
      { ...options, prefix: ['--fixture', 'space in argument'] },
      new AbortController().signal,
      fixture.start,
    )
    expect(history.boundaries).toEqual([{ id: 'msg_input', text: 'hello' }])
    expect(history.sessionId).toBe('ses_stored')
    const context = fixture.context()
    expect(context.record).toBe(session)
    expect(context.launch.home).toBe(options.home)
    expect(context.launch.command).toBe(process.execPath)
    expect(context.launch.args).toEqual(['--fixture', 'space in argument'])
    expect(context.launch.env).toMatchObject({
      KILO_CONFIG_DIR: join(options.home, 'kilo/config'),
      KILO_CONFIG_CONTENT: '{}',
      KILO_DISABLE_MODELS_FETCH: '1',
      KILO_DISABLE_AUTOUPDATE: '1',
      OPL_CHAT_EDIT_COMMAND: process.execPath,
      OPL_CHAT_EDIT_ARGS: JSON.stringify(['--fixture', 'space in argument']),
    })
    for (const key of ['KILO_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'])
      expect(context.launch.env[key]).toBeUndefined()
    expect(context.snapshot()).toEqual({ agent: {}, session: {}, configOptions: [] })
    expect(fixture.calls.at(-1)).toBe('closed')
    expect(session).toEqual(before)
  })

  it('rejects transport, reconnect and replay on its read-only context', async () => {
    const fixture = controlFixture()
    await readStoredKiloHistory(record(), options, new AbortController().signal, fixture.start)
    const context = fixture.context()
    expect(() => context.transport()).toThrow(ExternalMessageEditError)
    await expect(context.reconnect('another-session')).rejects.toMatchObject({
      code: 'unsupported',
    })
    await expect(context.replayHistory!()).rejects.toMatchObject({ code: 'unsupported' })
    await expect(context.disconnect()).resolves.toBeUndefined()
    expect(fixture.calls.filter((call) => call === 'start')).toHaveLength(1)
  })

  it('verifies a failed reply with an exact recorded input and stable idle reread', async () => {
    const fixture = controlFixture()
    const session = record()
    session.turns[0]!.state = 'failed'
    session.turns[0]!.stopReason = 'error_response'
    const failed = messages()
    failed[1]!.info.error = { name: 'APIError', data: { statusCode: 403 } }
    fixture.replaceHistory(failed)
    const history = await readStoredKiloHistory(
      session,
      options,
      new AbortController().signal,
      fixture.start,
    )
    expect(history.settledInputId).toBe('msg_input')
    expect(fixture.calls.filter((call) => call === 'read:ses_stored')).toHaveLength(2)
    expect(fixture.calls.at(-1)).toBe('closed')
  })

  it('closes the temporary control when stored history is invalid', async () => {
    const fixture = controlFixture()
    const invalid = messages()
    invalid[1]!.info.id = 'msg_input'
    fixture.replaceHistory(invalid)
    await expect(
      readStoredKiloHistory(record(), options, new AbortController().signal, fixture.start),
    ).rejects.toBeInstanceOf(ExternalMessageEditError)
    expect(fixture.calls.at(-1)).toBe('closed')
  })

  it('does not start control for cancelled or active records', async () => {
    const fixture = controlFixture()
    const cancelled = AbortSignal.abort()
    await expect(
      readStoredKiloHistory(record(), options, cancelled, fixture.start),
    ).rejects.toMatchObject({
      code: 'aborted',
    })
    const session = record()
    session.turns[0]!.state = 'running'
    await expect(
      readStoredKiloHistory(session, options, new AbortController().signal, fixture.start),
    ).rejects.toMatchObject({ code: 'busy' })
    expect(fixture.calls).toEqual([])
  })

  it('refuses a missing configured CLI without selecting another executable', async () => {
    const fixture = controlFixture()
    await expect(
      readStoredKiloHistory(
        record(),
        { ...options, command: join(options.home, 'absent-cli-entry') },
        new AbortController().signal,
        fixture.start,
      ),
    ).rejects.toMatchObject({ code: 'control-unavailable' })
    expect(fixture.calls).toEqual([])
  })
})
