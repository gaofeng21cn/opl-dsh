import { describe, expect, test } from 'vitest'
import {
  acpPermissionOptions,
  acpUpdatesForEvent,
  assertProtocolIdentity,
  assertSessionMode,
  redactSecret,
  resolvePermissionResponse,
  type ZcodeEvent,
} from '../../src/execution/host/adapters/zcode-protocol.ts'
const API_KEY = 'synthetic-key-must-not-leak'

test('requires the official protocol identity and authorized permission mode', () => {
  expect(() =>
    assertProtocolIdentity({ protocol: { name: 'ZCode Protocol', version: 1 } }),
  ).not.toThrow()
  expect(() => assertProtocolIdentity({})).toThrow()
  expect(() => assertProtocolIdentity({ protocol: { name: 'other', version: 1 } })).toThrow()
  expect(() =>
    assertSessionMode({ settings: { permission: { mode: 'yolo' } } }, 'yolo'),
  ).not.toThrow()
  expect(() => assertSessionMode({ settings: { permission: { mode: 'plan' } } }, 'yolo')).toThrow()
  expect(() => assertSessionMode({ session: { mode: 'yolo' } }, 'yolo')).toThrow()
})

describe('ZCode event to ACP update projection', () => {
  const event = (type: string, payload: Record<string, unknown>): ZcodeEvent => ({
    eventId: 'e1',
    sessionId: 's1',
    seq: 1,
    timestamp: 1,
    type,
    payload,
  })

  test('streams text and reasoning but drops tool IO fields', () => {
    const streamed = new Set<string>()
    expect(
      acpUpdatesForEvent(
        event('part.delta', { partId: 'p1', field: 'text', delta: 'a' }),
        streamed,
      ),
    ).toEqual([{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' } }])
    expect(
      acpUpdatesForEvent(
        event('part.delta', { partId: 'p2', field: 'reasoning', delta: 'b' }),
        streamed,
      ),
    ).toEqual([{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'b' } }])
    expect(
      acpUpdatesForEvent(
        event('part.delta', { partId: 'p3', field: 'output', delta: 'c' }),
        streamed,
      ),
    ).toEqual([])
    expect(
      acpUpdatesForEvent(
        event('part.delta', { partId: 'p4', field: 'input', delta: 'c' }),
        streamed,
      ),
    ).toEqual([])
  })

  test('projects the released app-server live stream and tool results', () => {
    const streamed = new Set<string>()
    expect(
      acpUpdatesForEvent(
        event('model.streaming', {
          kind: 'reasoning_delta',
          partId: 'thought',
          delta: 'checking',
        }),
        streamed,
      ),
    ).toEqual([
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'checking' } },
    ])
    expect(
      acpUpdatesForEvent(
        event('model.streaming', {
          kind: 'text_delta',
          partId: 'answer',
          delta: 'done',
        }),
        streamed,
      ),
    ).toEqual([{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } }])
    expect(
      acpUpdatesForEvent(
        event('model.streaming', {
          kind: 'tool_input_delta',
          delta: 'not assistant text',
        }),
        streamed,
      ),
    ).toEqual([])
    expect(
      acpUpdatesForEvent(
        event('part.upserted', {
          part: { type: 'text', partId: 'answer', text: 'done' },
        }),
        streamed,
      ),
    ).toEqual([])
    expect(
      acpUpdatesForEvent(
        event('tool.updated', {
          kind: 'scheduled',
          toolCallId: 'bash-1',
          toolName: 'Bash',
          input: { command: 'pwd' },
        }),
        streamed,
      ),
    ).toEqual([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'bash-1',
        title: 'Bash',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { command: 'pwd' },
      },
    ])
    expect(
      acpUpdatesForEvent(
        event('tool.updated', {
          kind: 'result',
          toolCallId: 'bash-1',
          toolName: 'Bash',
          result: { output: 'C:/src/opl-dsh' },
        }),
        streamed,
      ),
    ).toEqual([
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'bash-1',
        title: 'Bash',
        kind: 'execute',
        status: 'completed',
        rawOutput: { output: 'C:/src/opl-dsh' },
      },
    ])
    expect(
      acpUpdatesForEvent(
        event('tool.updated', {
          kind: 'error',
          toolCallId: 'bash-1',
          error: { message: 'failed' },
        }),
        streamed,
      ),
    ).toMatchObject([{ status: 'failed', rawOutput: { message: 'failed' } }])
    expect(
      acpUpdatesForEvent(event('session.titleUpdated', { title: 'Read-only check' }), streamed),
    ).toEqual([{ sessionUpdate: 'session_info_update', title: 'Read-only check' }])
  })

  test('does not re-emit a streamed part as a full upsert, but does replay a cold part', () => {
    const streamed = new Set<string>()
    acpUpdatesForEvent(event('part.delta', { partId: 'p1', field: 'text', delta: 'a' }), streamed)
    expect(
      acpUpdatesForEvent(
        event('part.upserted', { part: { type: 'text', partId: 'p1', text: 'a' } }),
        streamed,
      ),
    ).toEqual([])
    expect(
      acpUpdatesForEvent(
        event('part.upserted', { part: { type: 'text', partId: 'p9', text: 'cold' } }),
        streamed,
      ),
    ).toEqual([{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'cold' } }])
  })

  test('maps the official tool state machine onto tool_call and tool_call_update', () => {
    const streamed = new Set<string>()
    const part = (status: string) => ({
      part: {
        type: 'tool',
        partId: 'p',
        messageId: 'm',
        sessionId: 's',
        callId: 'c1',
        tool: 'bash',
        state: { status },
      },
    })
    expect(acpUpdatesForEvent(event('part.upserted', part('running')), streamed)).toEqual([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'c1',
        title: 'bash',
        kind: 'other',
        status: 'in_progress',
      },
    ])
    expect(acpUpdatesForEvent(event('part.upserted', part('completed')), streamed)).toEqual([
      { sessionUpdate: 'tool_call_update', toolCallId: 'c1', kind: 'other', status: 'completed' },
    ])
    expect(acpUpdatesForEvent(event('part.upserted', part('error')), streamed)).toEqual([
      { sessionUpdate: 'tool_call_update', toolCallId: 'c1', kind: 'other', status: 'failed' },
    ])
  })
})

describe('permission and secret handling', () => {
  const options = [
    { optionId: 'yes', kind: 'k', name: '允许', response: { decision: 'allow' as const } },
    { optionId: 'no', kind: 'k', name: '拒绝', response: { decision: 'deny' as const } },
    { optionId: 'esc', kind: 'k', name: '升级', response: { decision: 'escalate' as const } },
  ]

  test('drops ZCode decisions ACP cannot represent', () => {
    expect(acpPermissionOptions(options)).toEqual([
      { optionId: 'yes', name: '允许', kind: 'allow_once' },
      { optionId: 'no', name: '拒绝', kind: 'reject_once' },
    ])
  })

  test('fails closed when the answer does not match a known option', () => {
    expect(resolvePermissionResponse(options, 'yes')).toEqual({ decision: 'allow' })
    expect(resolvePermissionResponse(options, 'missing')).toEqual({ decision: 'deny' })
    expect(resolvePermissionResponse(options, undefined).decision).toBe('deny')
    expect(resolvePermissionResponse([options[0]], 'unknown').decision).toBe('deny')
  })

  test('redacts the credential from anything surfaced', () => {
    expect(redactSecret(`boom ${API_KEY}`, API_KEY)).toBe('boom [REDACTED]')
    expect(redactSecret('boom', undefined)).toBe('boom')
  })
})
