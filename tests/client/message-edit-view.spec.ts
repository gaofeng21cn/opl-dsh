import { expect, it, vi } from 'vitest'
import type { ConversationTimelineSnapshot } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Context } from '@deepseek-ai/cordis'
import {
  filterMessageEdits,
  installMessageEditNavigation,
  MESSAGE_EDIT_KIND,
} from '../../src/execution/client/message-edit-view.ts'

it('edit ranges remove old rows on incremental delivery and full replay; compaction is retained', () => {
  const replace = vi.fn((input) => input)
  const apply = vi.fn((input) => input)
  const builder = filterMessageEdits({ empty: null, replace, apply })
  const timeline = { turnOrder: [], turns: new Map() }
  const node = (seq: number, kind = 'user') => ({
    key: String(seq),
    id: String(seq),
    kind,
    target: 'chat',
    data: {},
    anchorSeq: seq,
  })
  const original = [node(1), node(2, 'assistant'), node(3, 'tool'), node(4, 'compaction')]
  const marker = {
    ...node(5, MESSAGE_EDIT_KIND),
    data: { marker: { version: 1, start: 2, end: 4, requestId: 'r1' } },
  }
  const admission = { ...node(6, MESSAGE_EDIT_KIND), key: 'admission', data: { requestId: 'r1' } }
  builder.replace({ nodes: original, timeline })
  builder.apply({ upserts: [marker], timeline })
  expect(
    replace.mock.lastCall![0].nodes.map((row: { anchorSeq: number }) => row.anchorSeq),
  ).toEqual([1, 2, 3, 4])
  builder.apply({ upserts: [admission, node(6)], timeline })
  expect(
    replace.mock.lastCall![0].nodes.map((row: { anchorSeq: number }) => row.anchorSeq),
  ).toEqual([1, 6])
  builder.replace({ nodes: [...original, marker, admission, node(6)], timeline })
  expect(
    replace.mock.lastCall![0].nodes.map((row: { anchorSeq: number }) => row.anchorSeq),
  ).toEqual([1, 6])
  builder.apply({ upserts: [node(7, 'compaction')], timeline })
  expect(
    replace.mock.lastCall![0].nodes.map((row: { anchorSeq: number }) => row.anchorSeq),
  ).toEqual([1, 6, 7])
})

it('replacement removes empty turn navigation and synthetic process/tail rows, retaining earlier content in a partial turn', () => {
  const replace = vi.fn((input) => input)
  const builder = filterMessageEdits({ empty: null, replace, apply: vi.fn() })
  // Only the public timeline fields consumed by the filter are needed here.
  const first = { turn: 1, start: { seq: 5 }, end: { seq: 18 } }
  const second = { turn: 2, start: { seq: 20 }, end: { seq: 28 } }
  const timeline = {
    turnOrder: [1, 2],
    turns: new Map([
      [1, first],
      [2, second],
    ]),
  } as unknown as ConversationTimelineSnapshot
  const row = (seq: number, kind: string, turn = first, visibility = 'visible') => ({
    key: `${kind}:${seq}`,
    id: String(seq),
    kind,
    target: 'chat',
    data: {},
    anchorSeq: seq,
    location: { kind: 'turn', turn },
    visibility,
  })
  const metadata = [
    {
      ...row(23, MESSAGE_EDIT_KIND, second),
      data: { marker: { version: 1, start: 9, end: 18, requestId: 'r' } },
    },
    { ...row(24, MESSAGE_EDIT_KIND, second), data: { requestId: 'r' } },
  ]
  const rows = [
    row(5.1, 'turn-process'),
    row(8, 'system-prompt'),
    row(9, 'user'),
    row(16, 'assistant'),
    row(18.1, 'turn-tail'),
    row(24, 'user', second),
    ...metadata,
  ]
  builder.replace({ nodes: rows, timeline })
  expect(
    replace.mock.lastCall![0].nodes.map((node: { anchorSeq: number }) => node.anchorSeq),
  ).toEqual([24])
  expect(replace.mock.lastCall![0].timeline.turnOrder).toEqual([2])
  const hiddenSnapshot = replace.mock.lastCall![0]
  const component = ({ useProjection }: { useProjection: (key: string) => unknown }) =>
    createElement('span', null, JSON.stringify(useProjection('turnOutline')))
  const entry = { options: { id: 'chat' }, component: component as unknown }
  const dispose = installMessageEditNavigation({
    slots: {
      entries: () => [entry],
      subscribe: () => () => {},
    },
  } as unknown as Context)
  const props = {
    useChat: (selector: (value: object) => unknown) => selector(hiddenSnapshot),
    useProjection: () => [
      { turn: 1, seq: 5 },
      { turn: 2, seq: 20 },
    ],
  }
  const html = renderToStaticMarkup(
    createElement(entry.component as ComponentType<typeof props>, props),
  )
  expect(html).toContain('2')
  expect(html).not.toContain('1')
  dispose()
  expect(entry.component).toBe(component)
  builder.replace({ nodes: [row(6, 'user'), ...rows], timeline })
  expect(replace.mock.lastCall![0].timeline.turnOrder).toEqual([1, 2])
  expect(
    replace.mock.lastCall![0].nodes.some((node: { anchorSeq: number }) => node.anchorSeq === 6),
  ).toBe(true)
})
