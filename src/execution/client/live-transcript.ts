/** Restore a live external stream shadowed by independent tool transcript settlements. */
import type {
  ConversationNodeDefinition,
  ConversationNodeContext,
  ConversationMatch,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { HARNESS_TRANSCRIPT_TOOL } from '../contracts/tool-display.ts'

export interface LiveTranscriptBlock {
  type: 'text' | 'reasoning'
  text: string
}
export interface LiveTranscriptState {
  blocks: LiveTranscriptBlock[]
  external: boolean
  closed: boolean
}
export const LIVE_TRANSCRIPT_KIND = 'opl-live-transcript'
declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    'opl-live-transcript': { blocks: readonly LiveTranscriptBlock[] }
  }
}

function fold(state: LiveTranscriptState, match: ConversationMatch): LiveTranscriptState {
  const event = match.event
  if (event.type === 'tool/call' && event.data.name === HARNESS_TRANSCRIPT_TOOL)
    return { ...state, external: true }
  if (event.type === 'step/end') return { ...state, closed: true }
  if (event.type === 'assistant/attempt') return { ...state, blocks: [], closed: false }
  if (event.type !== 'assistant/live-chunk') return state
  const chunk = event.data.chunk
  const blocks = state.blocks.slice()
  switch (chunk.type) {
    case 'block-start':
      if (chunk.blockType === 'text' || chunk.blockType === 'reasoning')
        blocks[chunk.index] = { type: chunk.blockType, text: '' }
      break
    case 'text-delta':
    case 'reasoning-delta': {
      const type = chunk.type === 'text-delta' ? 'text' : 'reasoning'
      blocks[chunk.index] = { type, text: (blocks[chunk.index]?.text ?? '') + chunk.text }
      break
    }
    case 'block-end':
      if (chunk.block.type === 'text' || chunk.block.type === 'reasoning')
        blocks[chunk.index] = { ...chunk.block }
      break
    default:
      return state
  }
  return { ...state, blocks }
}

/** Event-driven fallback only while official rc.2 projects a tool-only final assistant. */
export const liveTranscriptDefinition: ConversationNodeDefinition<LiveTranscriptState> = {
  kind: LIVE_TRANSCRIPT_KIND,
  target: 'chat',
  match(event) {
    if (
      event.type === 'assistant/live-chunk' ||
      event.type === 'step/start' ||
      event.type === 'step/end' ||
      event.type === 'assistant/attempt' ||
      event.type === 'assistant/message' ||
      (event.type === 'tool/call' && event.data.name === HARNESS_TRANSCRIPT_TOOL)
    )
      return {
        id: `${event.data.turn}:${event.data.step}`,
        role:
          event.type === 'step/start' ||
          event.type === 'assistant/live-chunk' ||
          event.type === 'tool/call'
            ? 'start'
            : 'update',
      }
    return null
  },
  start(_context, match) {
    return fold({ blocks: [], external: false, closed: false }, match)
  },
  update(context, match) {
    return fold(context.state, match)
  },
  publication(match) {
    return match.event.type === 'assistant/live-chunk' ? 'animation-frame' : 'immediate'
  },
  buildViewNode(
    context: ConversationNodeContext<LiveTranscriptState>,
  ): ChatConversationViewNode | null {
    const location = context.start?.location ?? context.matches.at(-1)?.location
    const state = context.state
    const official =
      location?.kind === 'step' ? location.step.data.get('assistant-step') : undefined
    const current = context.current.get('chat') as ChatConversationViewNode | undefined
    const blocks = state?.blocks.filter((block) => block?.text) ?? []
    // Newer official projections that retain live content require no additional row.
    const shadowed =
      official?.status === 'settled' &&
      official.blocks.length > 0 &&
      official.blocks.every((block) => block.kind === 'tool-call')
    if (
      !state?.external ||
      state.closed ||
      location?.kind !== 'step' ||
      location.step.status === 'closed' ||
      !shadowed ||
      !blocks.length
    )
      return current ? { ...current, visibility: 'hidden' } : null
    return {
      key: context.key,
      id: context.id,
      kind: LIVE_TRANSCRIPT_KIND,
      target: 'chat',
      anchorSeq:
        context.matches.find((match) => match.event.type === 'tool/call')?.event.seq ??
        context.matches[0]!.event.seq,
      // rc.2's process panel also treats a tool-only final as settled and clips
      // its children. Keep the missing live row in the ordinary transcript,
      // outside that panel, while retaining the real step for the guard above.
      location: { kind: 'session' },
      visibility: 'visible',
      data: { blocks },
    }
  },
}
