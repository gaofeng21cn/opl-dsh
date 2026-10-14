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

async function render(projectless: boolean) {
  const container = dom.container()
  const setDraft = vi.fn()
  const submit = vi.fn()
  root = createRoot(container as unknown as HTMLElement)
  await act(async () =>
    root!.render(
      createElement(ProjectlessComposer, {
        session: { sessionId: 'session-projectless', blank: true } as never,
        input: { draft: '', phase: 'plain' } as never,
        inputActions: { setDraft, submit } as never,
        useWorkspaces: (
          select: (state: { items: readonly { sessionIds: readonly string[] }[] }) => unknown,
        ) =>
          select(
            projectless ? { items: [{ sessionIds: ['session-projectless'] }] } : { items: [] },
          ),
      }),
    ),
  )
  return { container, setDraft, submit }
}

it('renders a working draft and submit surface for an ungrouped blank Session', async () => {
  const { container } = await render(false)
  expect(container.textContent).toContain('发送')
})

it('does not add a second composer inside a Workspace', async () => {
  expect((await render(true)).container.textContent).toBe('')
})
