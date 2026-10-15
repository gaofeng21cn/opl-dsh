import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { createTestDom } from './dom.ts'
import { ProjectlessComposer } from '../../src/execution/client/ProjectlessComposer.tsx'

const dom = createTestDom()
let root: Root | undefined

afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
})

async function render() {
  const container = dom.container()
  const setDraft = vi.fn()
  const submit = vi.fn()
  root = createRoot(container as unknown as HTMLElement)
  await act(async () =>
    root!.render(
      createElement(ProjectlessComposer, {
        session: { sessionId: 'session-projectless' } as never,
        pendingInteraction: undefined,
        matched: {},
        useInput: (select: (state: { draft: string; phase: string }) => unknown) =>
          select({ draft: '', phase: 'plain' }),
        inputActions: { setDraft, submit } as never,
      }),
    ),
  )
  return { container, setDraft, submit }
}

it('renders a working draft and submit surface for an ungrouped Session', async () => {
  const { container } = await render()
  expect(container.textContent).toContain('发送')
})
