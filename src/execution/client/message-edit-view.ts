/** Filter explicitly superseded edit history while retaining ordinary compaction transcripts. */
import type {
  ConversationNodeDefinition,
  ConversationViewBuilder,
  ConversationViewDefinition,
  ConversationViewNode,
  ConversationTimelineSnapshot,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { messageEditMarker, type MessageEditMarker } from '../contracts/message-edit.ts'
import { createElement, useMemo, type ComponentType } from 'react'
import type { ChatViewSlotProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
import type { Context } from '@deepseek-ai/cordis'
import { projectDeliverAssets } from './deliver-assets-view.ts'

const emptyHiddenTurns: ReadonlySet<number> = new Set()
const hiddenTurnsBySnapshot = new WeakMap<object, ReadonlySet<number>>()

export const MESSAGE_EDIT_KIND = 'opl-message-edit'
interface EditViewData {
  marker?: MessageEditMarker
  requestId?: string
}
export const messageEditDefinition: ConversationNodeDefinition<EditViewData> = {
  kind: MESSAGE_EDIT_KIND,
  target: 'chat',
  match(event) {
    if (
      event.type === 'user/message' &&
      'rpcId' in event.data.source &&
      typeof event.data.source.rpcId === 'string'
    )
      return { id: String(event.seq), role: 'start' }
    if (event.type !== 'system/message') return null
    const marker = messageEditMarker(event.data.message.source)
    return marker ? { id: String(event.seq), role: 'start' } : null
  },
  start(_context, match) {
    if (match.event.type === 'user/message' && 'rpcId' in match.event.data.source)
      return { requestId: String(match.event.data.source.rpcId) }
    if (match.event.type !== 'system/message') throw Error('Invalid message edit marker')
    return { marker: messageEditMarker(match.event.data.message.source)! }
  },
  update(context) {
    return context.state
  },
  buildViewNode(context) {
    return {
      key: context.key,
      id: context.id,
      kind: MESSAGE_EDIT_KIND,
      target: 'chat',
      data: context.state,
      anchorSeq: context.start!.event.seq,
      location: { kind: 'session' },
      visibility: 'hidden',
    }
  },
}

/** Wrap the published builder factory, not the official component or its private state. */
export function filterMessageEdits<Node extends ConversationViewNode, Snapshot>(
  builder: ConversationViewBuilder<Node, Snapshot>,
): ConversationViewBuilder<Node, Snapshot> {
  const raw = new Map<string, Node>()
  let hiddenTurns: ReadonlySet<number> = emptyHiddenTurns
  const publish = (snapshot: Snapshot): Snapshot => {
    if (snapshot && typeof snapshot === 'object') hiddenTurnsBySnapshot.set(snapshot, hiddenTurns)
    return snapshot
  }
  function filtered(timeline: ConversationTimelineSnapshot) {
    const metadata = [...raw.values()].flatMap((node) =>
      node.kind === MESSAGE_EDIT_KIND ? [node.data as EditViewData] : [],
    )
    const admitted = new Set(metadata.map((value) => value.requestId))
    const ranges = metadata.flatMap((value) =>
      value.marker && admitted.has(value.marker.requestId) ? [value.marker] : [],
    )
    const covered = (seq: number) => ranges.some((range) => seq >= range.start && seq <= range.end)
    const nodes = [...raw.values()].filter(
      (node) =>
        node.kind !== MESSAGE_EDIT_KIND &&
        !('anchorSeq' in node && typeof node.anchorSeq === 'number' && covered(node.anchorSeq)),
    )
    const turnOf = (node: Node) => {
      if (!('location' in node) || !node.location || typeof node.location !== 'object')
        return undefined
      const at = node.location
      return 'turn' in at && at.turn && typeof at.turn === 'object' && 'turn' in at.turn
        ? at.turn.turn
        : undefined
    }
    const turns = new Map(
      [...timeline.turns].filter(([turn, location]) => {
        if (!location.start || !location.end) return true
        return !ranges.some(
          (range) =>
            Number(location.end!.seq) >= range.start &&
            Number(location.end!.seq) <= range.end &&
            !nodes.some(
              (node) =>
                turnOf(node) === turn &&
                node.kind !== 'turn-process' &&
                node.kind !== 'turn-tail' &&
                node.kind !== 'system-prompt' &&
                (!('visibility' in node) || node.visibility !== 'hidden'),
            ),
        )
      }),
    )
    hiddenTurns = new Set([...timeline.turns.keys()].filter((turn) => !turns.has(turn)))
    return {
      nodes: nodes.filter((node) => {
        const turn = turnOf(node)
        return typeof turn !== 'number' || turns.has(turn)
      }),
      timeline: { turns, turnOrder: timeline.turnOrder.filter((turn) => turns.has(turn)) },
    }
  }
  return {
    empty: builder.empty,
    replace(input) {
      raw.clear()
      for (const node of input.nodes) raw.set(node.key, node)
      return publish(builder.replace(filtered(input.timeline)))
    },
    apply(input) {
      for (const node of input.upserts) raw.set(node.key, node)
      if (
        ![...raw.values()].some(
          (node) => node.kind === MESSAGE_EDIT_KIND && (node.data as EditViewData).marker,
        )
      )
        return publish(
          builder.apply({
            ...input,
            upserts: input.upserts.filter((node) => node.kind !== MESSAGE_EDIT_KIND),
          }),
        )
      return publish(builder.replace(filtered(input.timeline)))
    },
    ...(builder.groupInput ? { groupInput: () => builder.groupInput!() } : {}),
    ...(builder.publish ? { publish: () => builder.publish!() } : {}),
  }
}

/** Keep unloaded-history rail entries from resurrecting explicitly replaced turns. */
export function installMessageEditNavigation(ctx: Context): () => void {
  const seen = new WeakSet<object>()
  const restorers: (() => void)[] = []
  const install = () => {
    for (const entry of ctx.slots.entries('conversation.view')) {
      if (entry.options.id !== 'chat' || seen.has(entry)) continue
      seen.add(entry)
      // The chat slot owns these published props; the registry erases component types.
      // rc.2 supplies the standard projection hook at runtime; the alpha face omits it.
      type Props = ChatViewSlotProps & { useProjection: UseProjection }
      const original = entry.component as ComponentType<Props>
      const wrapped = (props: Props) => {
        const hidden = props.useChat(
          (snapshot) => hiddenTurnsBySnapshot.get(snapshot) ?? emptyHiddenTurns,
        )
        const read = props.useProjection as (key: string, ...args: unknown[]) => unknown
        const outline = read('turnOutline')
        const filtered = useMemo(
          () =>
            Array.isArray(outline)
              ? outline.filter(
                  (item: unknown) =>
                    !item ||
                    typeof item !== 'object' ||
                    !('turn' in item) ||
                    typeof item.turn !== 'number' ||
                    !hidden.has(item.turn),
                )
              : outline,
          [outline, hidden],
        )
        const useProjection = ((key: string, ...args: unknown[]) => {
          if (key !== 'turnOutline') return read(key, ...args)
          const selector = args[0]
          return typeof selector === 'function' ? selector(filtered) : filtered
        }) as UseProjection
        return createElement(original, { ...props, useProjection })
      }
      entry.component = wrapped
      restorers.push(() => {
        if (entry.component === wrapped) entry.component = original
      })
    }
  }
  install()
  const off = ctx.slots.subscribe('conversation.view', install)
  return () => {
    off()
    for (const restore of restorers) restore()
  }
}

/** Project edit history and file deliveries through current and later official Chat builders. */
export function installMessageEditViews(registry: {
  entries(): readonly ConversationViewDefinition[]
  subscribe(listener: () => void): () => void
}): () => void {
  const restorers: (() => void)[] = []
  const seen = new WeakSet<ConversationViewDefinition>()
  const install = () => {
    for (const definition of registry.entries()) {
      if (definition.target !== 'chat' || seen.has(definition)) continue
      seen.add(definition)
      const original = definition.create
      const wrapped = () => filterMessageEdits(projectDeliverAssets(original.call(definition)))
      definition.create = wrapped
      restorers.push(() => {
        if (definition.create === wrapped) definition.create = original
      })
    }
  }
  install()
  const off = registry.subscribe(install)
  return () => {
    off()
    for (const restore of restorers) restore()
  }
}
