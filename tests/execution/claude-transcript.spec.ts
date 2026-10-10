import { describe, expect, test } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { HarnessSession } from '../../src/execution/contracts/sessions.ts'
import { NativeHarnessConversations } from '../../src/execution/host/native-conversations.ts'
import {
  acpUpdatesForClaudeEvent,
  type AcpUpdate,
} from '../../src/execution/host/adapters/claude-transcript.ts'

/** Session and tool ids below are the real ones read back from the official Claude SDK by the
 * Kiro smoke (`kiro-smoke-sdk-tool-evidence.json`), so the fixtures carry the event fields the
 * CLI actually emits rather than a guessed shape. */
const SESSION = 'a68484cd-4e1d-4f3e-bbbd-eb1af8e8a3c7'
const PWD_ID = 'tooluse_3y7F9VE1UI6rlhfzMlU482'
const ROOT_ID = 'tooluse_9mut9KYXcx0kAg9uPttMtu'
const SHELL_ID = 'tooluse_Xb0gsRlT11RKKtj8vgkrtk'

/** `SDKAssistantMessage` shaped like an Anthropic Messages API assistant message. */
const assistant = (content: unknown[], stopReason: string | null = null) => ({
  type: 'assistant',
  message: {
    id: 'msg_01real',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-5',
    content,
    stop_reason: stopReason,
    usage: { input_tokens: 1, output_tokens: 1 },
  },
  parent_tool_use_id: null,
  uuid: 'uuid-assistant',
  session_id: SESSION,
})

/** `SDKUserMessage` shaped like the user message the CLI builds from a tool result. */
const user = (content: unknown[], toolUseResult?: unknown) => ({
  type: 'user',
  message: { role: 'user', content },
  parent_tool_use_id: null,
  uuid: 'uuid-user',
  session_id: SESSION,
  ...(toolUseResult !== undefined ? { tool_use_result: toolUseResult } : {}),
})

/** The three real Bash tool calls and results the smoke recorded, in the order they ran. */
const realToolCalls = [
  { type: 'tool_use', id: PWD_ID, name: 'Bash', input: { command: 'pwd' } },
  {
    type: 'tool_use',
    id: ROOT_ID,
    name: 'Bash',
    input: { command: 'git rev-parse --show-toplevel' },
  },
  {
    type: 'tool_use',
    id: SHELL_ID,
    name: 'Bash',
    input: { command: 'echo $SHELL && $SHELL --version | head -n1' },
  },
]
const realResults = [
  {
    type: 'tool_result',
    tool_use_id: PWD_ID,
    is_error: false,
    content: '/tmp/opl-dsh-official-main-20261007',
  },
  {
    type: 'tool_result',
    tool_use_id: ROOT_ID,
    is_error: false,
    content: 'C:/Users/root/AppData/Local/Temp/opl-dsh-official-main-20261007',
  },
  {
    type: 'tool_result',
    tool_use_id: SHELL_ID,
    is_error: false,
    content: '/bin/bash.exe\nGNU bash, version 5.3.15(1)-release (x86_64-pc-cygwin)',
  },
]

describe('Claude tool call projection', () => {
  test('keeps the complete tool input the model chose', () => {
    const [update, ...rest] = acpUpdatesForClaudeEvent(assistant([realToolCalls[0]], 'tool_use'))
    expect(rest).toEqual([])
    expect(update).toEqual({
      sessionUpdate: 'tool_call',
      toolCallId: PWD_ID,
      title: 'Bash',
      status: 'in_progress',
      kind: 'other',
      rawInput: { command: 'pwd' },
    })
  })

  test('associates several tool calls in one assistant message with their own ids', () => {
    const updates = acpUpdatesForClaudeEvent(assistant(realToolCalls))
    expect(updates.map((u) => u.sessionUpdate)).toEqual(['tool_call', 'tool_call', 'tool_call'])
    expect(updates.map((u) => u.toolCallId)).toEqual([PWD_ID, ROOT_ID, SHELL_ID])
    expect(updates.map((u) => u.rawInput)).toEqual([
      { command: 'pwd' },
      { command: 'git rev-parse --show-toplevel' },
      { command: 'echo $SHELL && $SHELL --version | head -n1' },
    ])
  })

  test('reports a completed string result as a renderable preview', () => {
    expect(acpUpdatesForClaudeEvent(user([realResults[0]]))).toEqual([
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: PWD_ID,
        status: 'completed',
        kind: 'other',
        rawOutput: '/tmp/opl-dsh-official-main-20261007',
        content: [
          {
            type: 'content',
            content: { type: 'text', text: '/tmp/opl-dsh-official-main-20261007' },
          },
        ],
      },
    ])
  })

  test('reports a real failure as failed and keeps the error text', () => {
    const [update] = acpUpdatesForClaudeEvent(
      user([
        {
          type: 'tool_result',
          tool_use_id: PWD_ID,
          is_error: true,
          content: 'Error: exit status 128\nfatal: not a git repository',
        },
      ]),
    )
    expect(update!.status).toBe('failed')
    expect(update!.toolCallId).toBe(PWD_ID)
    expect(update!.content).toEqual([
      {
        type: 'content',
        content: { type: 'text', text: 'Error: exit status 128\nfatal: not a git repository' },
      },
    ])
  })

  test('reads a content block array as tool output text', () => {
    const [update] = acpUpdatesForClaudeEvent(
      user([
        {
          type: 'tool_result',
          tool_use_id: ROOT_ID,
          is_error: false,
          content: [
            {
              type: 'text',
              text: 'C:/Users/root/AppData/Local/Temp/opl-dsh-official-main-20261007',
            },
            { type: 'text', text: 'on branch main' },
          ],
        },
      ]),
    )
    expect(update!.content).toEqual([
      {
        type: 'content',
        content: {
          type: 'text',
          text: 'C:/Users/root/AppData/Local/Temp/opl-dsh-official-main-20261007',
        },
      },
      { type: 'content', content: { type: 'text', text: 'on branch main' } },
    ])
  })

  test('carries the structured tool output alongside the text instead of replacing it', () => {
    const structured = {
      stdout: '/tmp/opl-dsh-official-main-20261007',
      stderr: '',
      interrupted: false,
      isImage: false,
    }
    const [update] = acpUpdatesForClaudeEvent(user([realResults[0]], structured))
    expect(update!.rawOutput).toEqual(structured)
    expect(update!.content).toEqual([
      {
        type: 'content',
        content: { type: 'text', text: '/tmp/opl-dsh-official-main-20261007' },
      },
    ])
  })

  test('keeps every result of a parallel tool batch attached to its own call', () => {
    const updates = acpUpdatesForClaudeEvent(user(realResults))
    expect(updates.map((u) => u.toolCallId)).toEqual([PWD_ID, ROOT_ID, SHELL_ID])
    expect(updates.map((u) => u.status)).toEqual(['completed', 'completed', 'completed'])
    expect(updates.map((u) => (u.content as AcpUpdate[])[0].content)).toEqual([
      { type: 'text', text: '/tmp/opl-dsh-official-main-20261007' },
      { type: 'text', text: 'C:/Users/root/AppData/Local/Temp/opl-dsh-official-main-20261007' },
      {
        type: 'text',
        text: '/bin/bash.exe\nGNU bash, version 5.3.15(1)-release (x86_64-pc-cygwin)',
      },
    ])
  })

  test('attaches structured output only when it belongs to a single result', () => {
    const structured = { stdout: 'only for one tool', stderr: '' }
    const [single] = acpUpdatesForClaudeEvent(user([realResults[0]], structured))
    expect(single!.rawOutput).toEqual(structured)
    const batch = acpUpdatesForClaudeEvent(user(realResults, structured))
    expect(batch.map((update) => update.rawOutput)).toEqual(realResults.map((r) => r.content))
  })

  test('preserves all result blocks when the SDK omits structured output', () => {
    const content = [
      { type: 'text', text: 'Screenshot attached' },
      { type: 'image', source: { data: 'AAAA', media_type: 'image/png' } },
    ]
    const [update] = acpUpdatesForClaudeEvent(
      user([{ type: 'tool_result', tool_use_id: ROOT_ID, is_error: false, content }]),
    )
    expect(update!.rawOutput).toEqual(content)
    expect(update!.content).toEqual([
      { type: 'content', content: { type: 'text', text: 'Screenshot attached' } },
    ])
  })

  test('keeps non-text output out of the preview without dropping the structured output', () => {
    const structured = {
      content: [{ type: 'image', source: { data: 'AAAA', media_type: 'image/png' } }],
    }
    const [update] = acpUpdatesForClaudeEvent(
      user(
        [
          {
            type: 'tool_result',
            tool_use_id: ROOT_ID,
            is_error: false,
            content: [{ type: 'image', source: { data: 'AAAA', media_type: 'image/png' } }],
          },
        ],
        structured,
      ),
    )
    expect(update!.content).toBeUndefined()
    expect(update!.rawOutput).toEqual(structured)
    expect(update!.status).toBe('completed')
  })
})

describe('Claude prose is never re-emitted or passed off as a tool result', () => {
  test('streams assistant text once and does not repeat it from the assistant block', () => {
    const streamed = acpUpdatesForClaudeEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Working directory is' },
      },
      parent_tool_use_id: null,
      uuid: 'uuid-stream',
      session_id: SESSION,
    })
    expect(streamed).toEqual([
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Working directory is' },
      },
    ])
    expect(
      acpUpdatesForClaudeEvent(
        assistant([{ type: 'text', text: 'Working directory is' }, realToolCalls[0]], 'tool_use'),
      ),
    ).toEqual([
      {
        sessionUpdate: 'tool_call',
        toolCallId: PWD_ID,
        title: 'Bash',
        status: 'in_progress',
        kind: 'other',
        rawInput: { command: 'pwd' },
      },
    ])
  })

  test('streams SDK thinking deltas separately without replaying completed thinking blocks', () => {
    expect(
      acpUpdatesForClaudeEvent({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'Checking the command result.' },
        },
      }),
    ).toEqual([
      {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Checking the command result.' },
      },
    ])
    expect(
      acpUpdatesForClaudeEvent(
        assistant([
          { type: 'thinking', thinking: 'Checking the command result.', signature: 'opaque' },
        ]),
      ),
    ).toEqual([])
    expect(
      acpUpdatesForClaudeEvent({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'signature_delta', signature: 'opaque' },
        },
      }),
    ).toEqual([])
  })

  test('ignores tool argument stream deltas and the model closing summary', () => {
    expect(
      acpUpdatesForClaudeEvent({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"command":"pwd"}' },
        },
        parent_tool_use_id: null,
        uuid: 'uuid-stream',
        session_id: SESSION,
      }),
    ).toEqual([])
    expect(
      acpUpdatesForClaudeEvent({
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 12,
        num_turns: 1,
        result: 'All three Bash commands succeeded.',
        session_id: SESSION,
        uuid: 'uuid-result',
        total_cost_usd: 0,
      }),
    ).toEqual([])
  })

  test('does not project a user message that carries only text', () => {
    expect(
      acpUpdatesForClaudeEvent(
        user([{ type: 'text', text: 'continue with the second file' }], { ignored: true }),
      ),
    ).toEqual([])
  })
})

describe('Claude projection drops anything without a usable tool call id', () => {
  test('ignores malformed and unknown events', () => {
    expect(acpUpdatesForClaudeEvent(undefined)).toEqual([])
    expect(acpUpdatesForClaudeEvent({ type: 'system', subtype: 'init' })).toEqual([])
    expect(acpUpdatesForClaudeEvent(assistant([{ type: 'tool_use', name: 'Bash' }]))).toEqual([])
    expect(acpUpdatesForClaudeEvent(user([{ type: 'tool_result', content: 'x' }]))).toEqual([])
    expect(acpUpdatesForClaudeEvent(user('a plain string prompt'))).toEqual([])
    expect(acpUpdatesForClaudeEvent({ type: 'assistant' })).toEqual([])
  })

  test('keeps a result with no content rather than inventing text', () => {
    const [update] = acpUpdatesForClaudeEvent(
      user([{ type: 'tool_result', tool_use_id: PWD_ID, is_error: false }]),
    )
    expect(update).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: PWD_ID,
      status: 'completed',
      kind: 'other',
    })
  })
})

describe('Claude tool updates in the official Session log', () => {
  test.each([false, true])('persists tool arguments and output with is_error=%s', (isError) => {
    const session = Session.create(SessionId('claude-transcript-test'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const ctx = { sessions: { get: () => session } } as unknown as Context
    const bridge = new NativeHarnessConversations(ctx)
    const turn = {
      operationId: 'initial',
      fingerprint: 'test',
      prompt: 'read-only test',
      state: 'running' as const,
      text: '',
      tools: [],
    }
    const record: HarnessSession = {
      id: 'claude-transcript-test',
      combination: 'test-claude',
      harnessRef: 'claude',
      modelRef: { provider: 'opl-gateway', model: 'kiro::claude-opus-5-5' },
      cwd: process.cwd(),
      origin: { kind: 'codex', sessionId: 'test-reviewer' },
      title: 'test',
      sandbox: 'full-access',
      createdAt: '2026-10-10T00:00:00Z',
      updatedAt: '2026-10-10T00:00:00Z',
      turns: [turn],
    }
    const output = isError ? 'Command failed' : '/test-project'
    for (const event of [
      assistant([realToolCalls[0]]),
      user([{ type: 'tool_result', tool_use_id: PWD_ID, is_error: isError, content: output }]),
    ]) {
      for (const update of acpUpdatesForClaudeEvent(event))
        bridge.tool(session.id, record, turn, update)
    }
    const events = session.snapshotEvents()
    const call = events.find((e) => e.type === 'tool/call')!
    if (call.type !== 'tool/call') throw new Error('Missing tool call')
    const args = JSON.parse(call.data.arguments)
    expect(JSON.parse(args.tool.inputJson)).toEqual({ command: 'pwd' })
    const result = events.find((e) => e.type === 'tool/result')!
    if (result.type !== 'tool/result') throw new Error('Missing tool result')
    expect(result.data.message.toolCallId).toBe(call.data.callId)
    expect(result.data.message.isError).toBe(isError)
    expect(result.data.message.content).toEqual([{ type: 'text', text: output }])
  })
})
