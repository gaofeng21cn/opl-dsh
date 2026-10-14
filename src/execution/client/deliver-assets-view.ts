/** Project recognized file deliveries out of finalized assistant body text. */
import type {
  AssistantBlock,
  ConversationViewBuilder,
  ConversationViewNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { AssistantChatData, ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { parseDeliverAssets } from './deliver-assets-markup.ts'

/** Preserve non-text blocks and only remove markup represented by file rows. */
function deliveredBlocks(
  blocks: readonly AssistantBlock[],
  paths: ReadonlySet<string>,
): readonly AssistantBlock[] {
  const result: AssistantBlock[] = []
  let changed = false
  for (let index = 0; index < blocks.length; index++) {
    const first = blocks[index]!
    if (first.kind !== 'text') {
      result.push(first)
      continue
    }
    const start = index
    let text = first.text
    while (blocks[index + 1]?.kind === 'text') {
      const next = blocks[++index] as Extract<AssistantBlock, { kind: 'text' }>
      text += next.text
    }
    const segments = parseDeliverAssets(text)
    const assets = segments.filter((segment) => segment.kind === 'assets')
    if (
      !assets.length ||
      assets.some((segment) => segment.files.some((file) => !paths.has(file.path)))
    ) {
      result.push(...blocks.slice(start, index + 1))
      continue
    }
    changed = true
    const prose = segments
      .flatMap((segment) => (segment.kind === 'text' ? [segment.text] : []))
      .join('')
    if (prose.trim()) result.push({ kind: 'text', text: prose })
  }
  return changed ? result : blocks
}

/** Keep the durable message and copy-action data intact while cleaning its visible body. */
function projectNode<Node extends ConversationViewNode>(
  node: Node,
  deliveries: ReadonlyMap<string, Node>,
): Node {
  if (node.kind !== 'assistant-step') return node
  // The registered assistant-step kind owns this public payload.
  const data = node.data as AssistantChatData
  if (data.status !== 'settled' || !data.finalNode) return node
  const paths = new Set<string>()
  for (const delivery of deliveries.values()) {
    // collect() retains only our registered Chat kind and its typed payload.
    const row = delivery as unknown as ChatNode<'opl-deliver-assets'>
    if (row.visibility !== 'visible' || row.anchorSeq !== data.finalNode.seq) continue
    for (const file of row.data.files) paths.add(file.path)
  }
  if (!paths.size) return node
  const blocks = deliveredBlocks(data.blocks, paths)
  return blocks === data.blocks ? node : { ...node, data: { ...data, blocks } }
}

/**
 * Decorate the public Chat builder for incremental delivery and history replay.
 * @param builder - official builder receiving conversation nodes.
 * @returns a builder that retains prose, file rows and original message data.
 */
export function projectDeliverAssets<Node extends ConversationViewNode, Snapshot>(
  builder: ConversationViewBuilder<Node, Snapshot>,
): ConversationViewBuilder<Node, Snapshot> {
  const deliveries = new Map<string, Node>()
  function collect(nodes: readonly Node[]) {
    for (const node of nodes) if (node.kind === 'opl-deliver-assets') deliveries.set(node.key, node)
  }
  return {
    empty: builder.empty,
    replace: (input) => {
      deliveries.clear()
      collect(input.nodes)
      return builder.replace({
        ...input,
        nodes: input.nodes.map((node) => projectNode(node, deliveries)),
      })
    },
    apply: (input) => {
      collect(input.upserts)
      return builder.apply({
        ...input,
        upserts: input.upserts.map((node) => projectNode(node, deliveries)),
      })
    },
    ...(builder.groupInput ? { groupInput: () => builder.groupInput!() } : {}),
    ...(builder.publish ? { publish: () => builder.publish!() } : {}),
  }
}
