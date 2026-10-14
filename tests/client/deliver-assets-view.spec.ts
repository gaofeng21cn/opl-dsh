import { expect, it, vi } from 'vitest'
import type {
  AssistantBlock,
  ConversationViewDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { projectDeliverAssets } from '../../src/execution/client/deliver-assets-view.ts'
import { installMessageEditViews } from '../../src/execution/client/message-edit-view.ts'
import { deliverAssetFiles } from '../../src/execution/client/deliver-assets-markup.ts'

const files = [
  [
    'C:/Users/root/Documents/Codex/repair-20261013/ofm-harness-adaptation/mimo/report.md',
    'MiMo Code 适配报告',
  ],
  [
    'C:/Users/root/Documents/Codex/repair-20261013/post-pr-features/repo/src/execution/host/adapters/mimo/mimo.ts',
    'mimo.ts —适配器主体',
  ],
  [
    'C:/Users/root/Documents/Codex/repair-20261013/post-pr-features/repo/src/execution/host/adapters/mimo/index.ts',
    'mimo/index.ts — 集成入口',
  ],
  [
    'C:/Users/root/Documents/Codex/repair-20261013/post-pr-features/repo/tests/execution/ofm-mimo/mimo-adapter.spec.ts',
    'mimo-adapter.spec.ts — 25 项行为证据',
  ],
  [
    'C:/Users/root/Documents/Codex/repair-20261013/post-pr-features/repo/tests/execution/ofm-mimo/probe.mjs',
    'probe.mjs — 官方 CLI 隔离探测',
  ],
]
const delivery =
  '<deliver-assets> ' +
  files.map(([path, name]) => `<media type="file" src="${path}" name="${name}" />`).join(' ') +
  ' </deliver-assets>'
const timeline = { turnOrder: [], turns: new Map() }
function assistant(blocks: readonly AssistantBlock[], status = 'settled') {
  const finalNode = { seq: 3, blocks }
  return {
    key: 'assistant',
    id: 'assistant',
    kind: 'assistant-step',
    target: 'chat',
    data: { status, blocks, finalNode },
  }
}
function fileCard(body = delivery) {
  return {
    key: 'assets',
    id: 'assets',
    kind: 'opl-deliver-assets',
    target: 'chat',
    anchorSeq: 3,
    visibility: 'visible',
    data: { files: deliverAssetFiles(body) },
  }
}
function fixture() {
  const replace = vi.fn((input) => input)
  const apply = vi.fn((input) => input)
  return { replace, apply, builder: projectDeliverAssets({ empty: null, replace, apply }) }
}

it('shows the reported five-file delivery without XML in the finalized body or altering durable copy data', () => {
  const { builder, replace } = fixture()
  const body = `适配完成。\n\n${delivery}`
  const original = assistant([{ kind: 'text', text: body }])
  const card = fileCard(body)
  builder.replace({ nodes: [original, card], timeline })
  const [visible, retainedCard] = replace.mock.lastCall![0].nodes
  expect(visible.data.blocks).toEqual([{ kind: 'text', text: '适配完成。\n\n' }])
  expect(visible.data.finalNode).toBe(original.data.finalNode)
  expect(original.data.blocks[0]).toEqual({ kind: 'text', text: body })
  expect(retainedCard).toBe(card)
  expect(card.data.files).toHaveLength(5)
})

it('projects late finalization and replay identically, retaining surrounding prose and reasoning', () => {
  const { builder, apply, replace } = fixture()
  const blocks: AssistantBlock[] = [
    { kind: 'reasoning', text: '保留思考' },
    { kind: 'text', text: `前文${delivery}后文` },
  ]
  const node = assistant(blocks)
  builder.apply({ upserts: [node, fileCard()], timeline })
  builder.replace({ nodes: [node, fileCard()], timeline })
  expect(apply.mock.lastCall![0].upserts).toEqual(replace.mock.lastCall![0].nodes)
  expect(apply.mock.lastCall![0].upserts[0].data.blocks).toEqual([
    { kind: 'reasoning', text: '保留思考' },
    { kind: 'text', text: '前文后文' },
  ])
})

it('recognizes a delivery split between adjacent text blocks and hides an attachment-only body', () => {
  const { builder, apply } = fixture()
  builder.apply({
    upserts: [
      assistant([
        { kind: 'text', text: delivery.slice(0, 100) },
        { kind: 'text', text: delivery.slice(100) },
      ]),
      fileCard(),
    ],
    timeline,
  })
  expect(apply.mock.lastCall![0].upserts[0].data.blocks).toEqual([])
})

it.each([
  '`' + delivery + '`',
  '```xml\n' + delivery + '\n```',
  '<deliver-assets><media type="image" src="C:/image.png" /></deliver-assets>',
  '<deliver-assets><media type="file" src="https://example.test/report.md" /></deliver-assets>',
  '<deliver-assets><media type="file" src="report.md" /></deliver-assets>',
  '<deliver-assets><media type="file" src="C:/report.md" />',
])('keeps code examples and unsupported markup unchanged: %s', (text) => {
  const { builder, apply } = fixture()
  const node = assistant([{ kind: 'text', text }])
  builder.apply({ upserts: [node], timeline })
  expect(apply.mock.lastCall![0].upserts[0]).toBe(node)
})

it('retains an unfinished streaming reply and leaves user text untouched', () => {
  const { builder, apply } = fixture()
  const running = assistant([{ kind: 'text', text: delivery }], 'running')
  const user = { ...assistant([{ kind: 'text', text: delivery }]), kind: 'user' }
  builder.apply({ upserts: [running, user], timeline })
  expect(apply.mock.lastCall![0].upserts).toEqual([running, user])
})

it('installs the projection through the actual factory decoration and restores it on unload', () => {
  const replace = vi.fn((input) => input)
  const create = () => ({ empty: null, replace, apply: vi.fn((input) => input) })
  const definition = { target: 'chat', create } as ConversationViewDefinition
  const off = vi.fn()
  const dispose = installMessageEditViews({ entries: () => [definition], subscribe: () => off })
  definition.create().replace({
    nodes: [assistant([{ kind: 'text', text: `完成${delivery}` }]), fileCard()],
    timeline,
  })
  expect(replace.mock.lastCall![0].nodes[0].data.blocks).toEqual([{ kind: 'text', text: '完成' }])
  dispose()
  expect(definition.create).toBe(create)
  expect(off).toHaveBeenCalledOnce()
})

it('retains markup when its file row is absent, hidden or belongs to another message', () => {
  const { builder, apply } = fixture()
  const node = assistant([{ kind: 'text', text: delivery }])
  builder.apply({ upserts: [node], timeline })
  expect(apply.mock.lastCall![0].upserts[0]).toBe(node)
  builder.apply({ upserts: [node, { ...fileCard(), anchorSeq: 4 }], timeline })
  expect(apply.mock.lastCall![0].upserts[0]).toBe(node)
  builder.apply({ upserts: [node, { ...fileCard(), visibility: 'hidden' }], timeline })
  expect(apply.mock.lastCall![0].upserts[0]).toBe(node)
})

it('retains unmapped files and clears old delivery identities when history changes', () => {
  const { builder, apply, replace } = fixture()
  const node = assistant([{ kind: 'text', text: delivery }])
  const partial = { ...fileCard(), data: { files: deliverAssetFiles(delivery).slice(0, 1) } }
  builder.apply({ upserts: [node, partial], timeline })
  expect(apply.mock.lastCall![0].upserts[0]).toBe(node)
  builder.apply({ upserts: [fileCard()], timeline })
  builder.apply({ upserts: [node], timeline })
  expect(apply.mock.lastCall![0].upserts[0].data.blocks).toEqual([])
  builder.replace({ nodes: [node], timeline })
  expect(replace.mock.lastCall![0].nodes[0]).toBe(node)
})
