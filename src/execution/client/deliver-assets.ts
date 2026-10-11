/**
 * Project official `<deliver-assets>` markup into ordinary conversation rows.
 *
 * Registered through the public `ctx.uiConversation.events.register` seam, so
 * it reuses the official event window, retry retirement, and history replay: a
 * Session that already stores the markup shows its file items the next time it
 * is displayed, with no re-dispatch, no tool re-execution and no file read.
 *
 * Only durable `assistant/message` events are matched. ACP writes an external
 * harness reply into exactly one such text block, so both the native DSH path
 * and every external harness converge here, and a block that is still streaming
 * simply has not produced a card yet.
 */
import type {
  ConversationNodeContext,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { deliverAssetFiles, type DeliverAssetFile } from './deliver-assets-markup.ts'
import type { ConversationMatch } from '@deepseek-ai/dsh-client-ui-conversation/client'

/** Renderer kind of the compact delivery row. */
export const DELIVER_ASSETS_KIND = 'opl-deliver-assets'

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    'opl-deliver-assets': { files: readonly DeliverAssetFile[] }
  }
}

/** Folded deliveries of one assistant step. */
export interface DeliverAssetsState {
  /** Converted local files; empty means the reply carried nothing to show. */
  readonly files: readonly DeliverAssetFile[]
  /** Seq of the assistant message the deliveries belong to. */
  readonly seq: number
}

type AssistantMessageEvent = SessionEvent<'assistant/message'>

/**
 * Read the assistant's own text out of one durable message.
 *
 * Only text blocks contribute; reasoning, tool calls and other content are the
 * official renderer's business and must not leak delivery markup into a card.
 * @param event - durable assistant message event.
 * @returns the concatenated text blocks.
 */
export function messageText(event: AssistantMessageEvent): string {
  const content = event.data.message?.content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content)
    if (block?.type === 'text' && typeof block.text === 'string') text += block.text
  return text
}

/**
 * Replace a step's deliveries or clear them when another attempt begins.
 * @param event - message or attempt lifecycle event.
 * @returns the state for this step.
 */
function fold(event: ConversationMatch['event']): DeliverAssetsState {
  return {
    files: event.type === 'assistant/message' ? deliverAssetFiles(messageText(event)) : [],
    seq: event.seq,
  }
}

/**
 * Show every real local file delivery of an assistant reply as one compact row.
 *
 * Additive by design: it contributes its own node beside the official assistant
 * row and leaves the stored message, the official Markdown body and the official
 * copy action untouched.
 */
export const deliverAssetsDefinition: ConversationNodeDefinition<DeliverAssetsState> = {
  kind: DELIVER_ASSETS_KIND,
  target: 'chat',
  match(event) {
    // Retry events are contributed by an optional official plugin and may be
    // absent from the consumer's declaration-merged Session event map.
    const type: string = event.type
    if (
      (type === 'llm/retry' || type === 'assistant/attempt') &&
      'turn' in event.data &&
      'step' in event.data
    )
      return { id: `${event.data.turn}:${event.data.step}`, role: 'start' }
    if (event.type !== 'assistant/message') return null
    // Only an append-origin message is the human transcript's durable source.
    // A `replace` op is a model-only copy produced when a surface range is
    // shadowed (compaction); rendering it here would show a delivery the user
    // never actually received, next to a message the official row also drops.
    // `surfaceOp` is required on message-producing events, so this gate never
    // drops a genuinely stored message.
    if (event.surfaceOp !== 'append') return null
    return { id: `${event.data.turn}:${event.data.step}`, role: 'start' }
  },
  start(_context, match) {
    return fold(match.event)
  },
  update(_context, match) {
    return fold(match.event)
  },
  buildViewNode(
    context: ConversationNodeContext<DeliverAssetsState>,
  ): ChatConversationViewNode | null {
    const state = context.state
    if (!state?.files.length) {
      const current = context.current.get('chat') as ChatConversationViewNode | undefined
      return current ? { ...current, visibility: 'hidden' } : null
    }
    return {
      key: context.key,
      id: context.id,
      kind: DELIVER_ASSETS_KIND,
      target: 'chat',
      // Anchor on the message itself so the row lands under its own reply.
      anchorSeq: state.seq,
      // Step-scoped custom rows are folded into the official process panel.
      // File deliveries belong in the readable transcript after the reply.
      location: { kind: 'session' },
      visibility: 'visible',
      data: { files: state.files },
    }
  },
}
