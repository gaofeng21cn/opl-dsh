import { createTestDom } from './dom.ts'
import { afterEach, expect, it, vi } from 'vitest'
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { LiveTranscriptRow } from '../../src/execution/client/LiveTranscriptRow.tsx'
import { DisclosureRow } from '@deepseek-ai/dsh-client-ui-primitives'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconThinkOutlineRegular: () => null,
  DisclosureRow: vi.fn(({ title, open, children, collapsedContent }: any) =>
    React.createElement('div', {}, title, open ? children : collapsedContent),
  ),
}))
const dom = createTestDom()
let root: ReturnType<typeof createRoot>
afterEach(async () => {
  await React.act(async () => root?.unmount())
})

it('updates the thought preview live and expands the complete received text', async () => {
  const container = dom.document.createElement('div')
  dom.document.body.appendChild(container)
  root = createRoot(container as unknown as HTMLElement)
  // Only provider text and the locale-owned label are supplied to this row.
  const view = (text: string) =>
    React.createElement(LiveTranscriptRow, {
      node: { data: { blocks: [{ type: 'reasoning', text }] } },
      t: () => 'Localized thinking',
    } as any)
  await React.act(async () => root.render(view('First line.\nSecond line.')))
  expect(container.textContent).toContain('Second line.')
  expect(container.textContent).not.toContain('First line.')
  await React.act(async () => root.render(view('First line.\nSecond line.\nNewest thought.')))
  expect(container.textContent).toContain('Newest thought.')
  const props = vi.mocked(DisclosureRow).mock.lastCall![0]
  expect(props).toMatchObject({ title: 'Localized thinking', running: true })
  await React.act(async () => props.onToggle!())
  expect(container.textContent).toContain('First line.\nSecond line.\nNewest thought.')
})
