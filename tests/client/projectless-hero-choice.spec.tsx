import { createTestDom } from './dom.ts'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'

let buttonProps: Record<string, unknown> | undefined
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: Record<string, unknown>) => {
    buttonProps = props
    return createElement('button', props, props.children as string | undefined)
  },
}))

import { ProjectlessHeroChoice } from '../../src/execution/client/ProjectlessHeroChoice.tsx'

const dom = createTestDom()
let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  buttonProps = undefined
})

it('offers projectless creation alongside the workspace picker', async () => {
  const create = vi.fn()
  const container = dom.container()
  root = createRoot(container as unknown as HTMLElement)
  await act(async () => root!.render(createElement(ProjectlessHeroChoice, { create })))
  expect(container.textContent).toContain('项目外')
  await act(async () => (buttonProps!.onClick as () => void)())
  expect(create).toHaveBeenCalledOnce()
})
