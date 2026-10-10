/** ACP projection of the official Claude Agent SDK transcript stream.
 *
 * This module owns no agent loop, no session state and no history: it maps one live SDK
 * event onto ACP `session/update` payloads and nothing else. The official Claude Code CLI
 * already decided which tools ran and what they returned, so every field here is a
 * projection of that CLI's own event rather than a reconstruction of it.
 */

export interface AcpUpdate {
  sessionUpdate: string
  [key: string]: unknown
}

/** An ACP tool preview block, the shape the Host reads back as display text. */
export interface AcpContentBlock {
  type: 'content'
  content: { type: 'text'; text: string }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * Human-readable preview blocks for a `tool_result` payload.
 *
 * ACP carries a tool preview as a `content` array, which is what the Host renders and what
 * `harnessToolOutput` reads back. Only text is projected: image and document blocks carry
 * data no transcript surface renders, and the tool's own structured output is not lost
 * because it still arrives separately through `rawOutput`.
 * @param content - the `tool_result` block content, a string or content blocks.
 * @returns ACP content blocks holding the real tool text.
 */
function toolResultContent(content: unknown): AcpContentBlock[] {
  if (typeof content === 'string')
    return content ? [{ type: 'content', content: { type: 'text', text: content } }] : []
  if (!Array.isArray(content)) return []
  return content.flatMap((block) => {
    const text = object(block).text
    return object(block).type === 'text' && typeof text === 'string' && text
      ? [{ type: 'content', content: { type: 'text', text } }]
      : []
  })
}

/**
 * Project one official Claude Agent SDK event into ACP `session/update` payloads.
 *
 * The SDK emits an assistant message per completed content block, so one message can carry
 * several `tool_use` blocks and one user message can carry the `tool_result` blocks
 * answering several of them. Each block becomes its own update keyed by the tool call id
 * the CLI assigned, which is what keeps parallel tool calls associated with their own
 * results.
 *
 * Assistant prose is deliberately not projected here: with `includePartialMessages` the CLI
 * already streamed it as text deltas, and re-emitting the block would duplicate the turn
 * body. For the same reason the `result` message — the model's closing summary — is never a
 * tool result.
 * @param event - one `SDKMessage` from the official SDK stream.
 * @returns the ACP updates this event contributes, in transcript order.
 */
export function acpUpdatesForClaudeEvent(event: unknown): AcpUpdate[] {
  const message = object(event)
  if (message.type === 'stream_event') {
    const streamed = object(message.event)
    const delta = object(streamed.delta)
    if (streamed.type !== 'content_block_delta') return []
    if (delta.type === 'thinking_delta')
      return typeof delta.thinking === 'string'
        ? [
            {
              sessionUpdate: 'agent_thought_chunk',
              content: { type: 'text', text: delta.thinking },
            },
          ]
        : []
    if (delta.type === 'text_delta')
      return typeof delta.text === 'string'
        ? [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: delta.text } }]
        : []
    return []
  }
  if (message.type === 'assistant') {
    const content = object(message.message).content
    if (!Array.isArray(content)) return []
    return content.flatMap((block) => {
      const tool = object(block)
      if (tool.type !== 'tool_use' || typeof tool.id !== 'string' || typeof tool.name !== 'string')
        return []
      return [
        {
          sessionUpdate: 'tool_call',
          toolCallId: tool.id,
          title: tool.name,
          status: 'in_progress',
          kind: 'other',
          // The complete arguments the model chose, not a summary of them.
          ...(tool.input !== undefined ? { rawInput: tool.input } : {}),
        },
      ]
    })
  }
  if (message.type === 'user') {
    const content = object(message.message).content
    if (!Array.isArray(content)) return []
    const results = content.filter(
      (block) =>
        object(block).type === 'tool_result' && typeof object(block).tool_use_id === 'string',
    )
    return results.map((block) => {
      const result = object(block)
      // `tool_use_result` is the CLI's structured output for the whole message; it belongs to
      // a single tool, so it is only attached when exactly one result answers that message.
      const structured =
        (results.length === 1 ? message.tool_use_result : undefined) ?? result.content
      const preview = toolResultContent(result.content)
      return {
        sessionUpdate: 'tool_call_update',
        toolCallId: result.tool_use_id,
        // A failed tool is reported failed, never as a completed call with error text.
        status: result.is_error === true ? 'failed' : 'completed',
        kind: 'other',
        ...(preview.length ? { content: preview } : {}),
        ...(structured !== undefined ? { rawOutput: structured } : {}),
      }
    })
  }
  return []
}
