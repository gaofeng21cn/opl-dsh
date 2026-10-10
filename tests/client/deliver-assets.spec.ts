import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { transformSync } from 'esbuild'
import type { ConversationViewDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { deliverAssetsDefinition as definition } from '../../src/execution/client/deliver-assets.ts'

// Official Client artifacts register a factory with the Desktop module loader.
// Load that public artifact in an isolated VM. Unused rendering dependencies
// throw on access so these tests cannot silently substitute UI behavior.
const require = createRequire(import.meta.url)
function unusedDependency(id: string) {
  return new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(`Unexpected dependency: ${id}.${String(property)}`)
      },
    },
  )
}
const storeModule = { exports: {} }
runInNewContext(
  transformSync(readFileSync(require.resolve('@deepseek-ai/dsh-client-store'), 'utf8'), {
    format: 'cjs',
  }).code,
  {
    module: storeModule,
    exports: storeModule.exports,
    // Zustand/Immer back the unrelated store API, which this assembler does not use.
    require: (id: string) => unusedDependency(id),
    console,
  },
)
let exported: typeof import('@deepseek-ai/dsh-client-ui-conversation/client')
runInNewContext(
  readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-conversation/client'), 'utf8'),
  {
    window: {
      __ModuleLoader__: {
        load({ factory }: { factory: (require: (id: string) => unknown) => typeof exported }) {
          exported = factory((id) =>
            id === '@deepseek-ai/dsh-client-ui-primitives'
              ? unusedDependency(id)
              : id === '@deepseek-ai/dsh-client-store'
                ? storeModule.exports
                : require(id),
          )
        },
      },
    },
  },
)
const { ConversationNodeAssembler } = exported!

// The public assembler owns replay, initialization and retained node identities.
// This view records its actual publications without replacing those lifecycle rules.
function conversation() {
  let seq = 0
  const history: { type: 'event'; event: SessionEvent }[] = []
  const view: ConversationViewDefinition<
    ChatConversationViewNode,
    ReadonlyMap<string, ChatConversationViewNode>
  > = {
    target: 'chat',
    create() {
      let nodes = new Map<string, ChatConversationViewNode>()
      return {
        empty: nodes,
        replace({ nodes: input }) {
          nodes = new Map(input.map((node) => [node.key, node]))
          return nodes
        },
        apply({ upserts }) {
          nodes = new Map(nodes)
          for (const node of upserts) nodes.set(node.key, node)
          return nodes
        },
      }
    },
  }
  const assembler = new ConversationNodeAssembler(
    { entries: () => [definition], fallbackEntry: () => undefined },
    { entries: () => [view] },
  )
  assembler.activateTarget('chat')
  assembler.replaceWindow([], false)
  assembler.flush()
  function append(type: string, data: object, surfaceOp: unknown = 'append') {
    // Only fields consulted by the public assembler/definition are needed in this fixture.
    const event = {
      type,
      data: { turn: 1, step: 1, ...data },
      seq: ++seq,
      time: seq,
      surfaceOp,
    } as unknown as SessionEvent
    const entry = { type: 'event' as const, event }
    history.push(entry)
    assembler.append(entry)
    assembler.flush()
  }
  append('turn/start', {})
  append('step/start', {})
  return {
    message(text: string, surfaceOp: unknown = 'append') {
      append('assistant/message', { message: { content: [{ type: 'text', text }] } }, surfaceOp)
    },
    reset(type: 'llm/retry' | 'assistant/attempt') {
      append(type, {})
    },
    replay() {
      assembler.replaceWindow(history, false)
      assembler.flush()
    },
    get node() {
      return (assembler.snapshot('chat') as ReadonlyMap<string, ChatConversationViewNode>)
        .values()
        .next().value
    },
  }
}
const delivery = (path: string) =>
  `<deliver-assets><media type="file" src="${path}" /></deliver-assets>`

describe('deliver-assets in the official conversation assembler', () => {
  it('publishes one row anchored to its own durable message', () => {
    const c = conversation()
    c.message(delivery('C:/out/report.md'))
    expect(c.node).toMatchObject({
      kind: 'opl-deliver-assets',
      anchorSeq: 3,
      visibility: 'visible',
      location: { kind: 'session' },
      data: { files: [{ path: 'C:/out/report.md', name: 'report.md' }] },
    })
  })
  it('leaves ordinary replies and code examples without attachment rows', () => {
    const c = conversation()
    c.message('ordinary reply')
    c.message('`' + delivery('C:/example.md') + '`')
    expect(c.node).toBeUndefined()
  })
  it('ignores replacement messages instead of overwriting a human-visible delivery', () => {
    const c = conversation()
    c.message(delivery('C:/real.md'))
    c.message(delivery('C:/shadow.md'), { op: 'replace', startSeq: 1, endSeq: 2 })
    expect(c.node?.data.files[0]?.path).toBe('C:/real.md')
  })
  it.each(['llm/retry', 'assistant/attempt'] as const)(
    'hides old files immediately on %s and reuses their node after the next reply',
    (type) => {
      const c = conversation()
      c.message(delivery('C:/old.md'))
      const key = c.node?.key
      c.reset(type)
      expect(c.node?.visibility).toBe('hidden')
      c.message(delivery('C:/new.md'))
      expect(c.node).toMatchObject({
        key,
        visibility: 'visible',
        data: { files: [{ path: 'C:/new.md', name: 'new.md' }] },
      })
      const live = c.node
      c.replay()
      expect(c.node).toMatchObject({
        key: live?.key,
        anchorSeq: live?.anchorSeq,
        visibility: 'visible',
        data: live?.data,
      })
    },
  )
  it('hides a published row when the next reply has no files without withdrawing its identity', () => {
    const c = conversation()
    c.message(delivery('C:/old.md'))
    c.message('no files this time')
    expect(c.node?.visibility).toBe('hidden')
    c.replay()
    expect(c.node).toBeUndefined()
  })
  it('does not create a row from retry events without an earlier reply', () => {
    const c = conversation()
    c.reset('llm/retry')
    c.reset('assistant/attempt')
    expect(c.node).toBeUndefined()
    c.message(delivery('C:/new.md'))
    expect(c.node?.visibility).toBe('visible')
  })
})
