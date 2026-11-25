import { createTestDom } from './dom.ts'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { CodexKeyringSetupProps } from '../../src/gateway/client/CodexKeyringSetup.tsx'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Button: 'button' }))
const { CodexKeyringSetup } = await import('../../src/gateway/client/CodexKeyringSetup.tsx')
const roots: Root[] = []
afterEach(async () => {
  await act(async () => roots.splice(0).forEach((root) => root.unmount()))
})
type Element = { nodeName: string; childNodes: Element[]; textContent: string }
const walk = (element: Element): Element[] => [element, ...(element.childNodes ?? []).flatMap(walk)]
const ok = { configured: true, needsInstall: false, message: '测试配置成功' }
async function mount(
  platform: string,
  distros: string[],
  configure: CodexKeyringSetupProps['configure'],
) {
  const container = createTestDom().container()
  Object.defineProperty(Object.getPrototypeOf(container), 'options', {
    configurable: true,
    get(this: Element) {
      return walk(this).filter((node) => node.nodeName === 'OPTION')
    },
  })
  const root = createRoot(container as unknown as HTMLElement)
  roots.push(root)
  const targets = vi.fn(async () => ({ platform, distros }))
  await act(async () => root.render(<CodexKeyringSetup targets={targets} configure={configure} />))
  const find = (tag: string) =>
    walk(container as unknown as Element).filter((n) => n.nodeName === tag)
  const props = (tag: string, index = 0) => {
    const node = find(tag)[index]!
    const key = Object.keys(node).find((key) => key.startsWith('__reactProps$'))!
    return (
      node as unknown as Record<
        string,
        {
          disabled?: boolean
          onChange: (e: { target: { value: string } }) => void
          onClick: () => void
          onToggle: (e: { currentTarget: { open: boolean } }) => void
        }
      >
    )[key]!
  }
  expect(targets).not.toHaveBeenCalled()
  await act(async () => props('DETAILS').onToggle({ currentTarget: { open: true } }))
  return {
    button: () => find('BUTTON')[0]!,
    disabled: () => props('BUTTON').disabled,
    choose: async (n: number, value: string) =>
      act(async () => props('SELECT', n).onChange({ target: { value } })),
    click: async () => act(async () => props('BUTTON').onClick()),
    selects: () => find('SELECT').length,
    text: () => container.textContent,
  }
}
it('requires a Windows environment and scopes WSL install consent to the selected distro', async () => {
  const configure = vi
    .fn()
    .mockResolvedValueOnce({ configured: false, needsInstall: true, message: '需安装钥匙串' })
    .mockResolvedValueOnce({ configured: false, needsInstall: true, message: '需安装钥匙串' })
    .mockResolvedValue(ok)
  const ui = await mount('win32', ['A', 'B'], configure)
  expect(ui.disabled()).toBe(true)
  await ui.choose(0, 'wsl')
  expect(ui.disabled()).toBe(true)
  await ui.choose(1, 'A')
  await ui.click()
  expect(configure).toHaveBeenLastCalledWith('wsl', 'A', false)
  expect(ui.button().textContent).toBe('安装钥匙串并配置')
  await ui.choose(1, 'B')
  expect(ui.button().textContent).toBe('一键配置')
  await ui.click()
  await ui.click()
  expect(configure.mock.calls.slice(-2)).toEqual([
    ['wsl', 'B', false],
    ['wsl', 'B', true],
  ])
  expect(ui.text()).toContain(ok.message)
  await ui.choose(0, 'windows')
  await ui.click()
  expect(configure).toHaveBeenLastCalledWith('windows', '', false)
})
it('selects macOS automatically and suppresses duplicate submissions while configuring', async () => {
  let release!: (value: typeof ok) => void
  const configure = vi.fn(
    () =>
      new Promise<typeof ok>((resolve) => {
        release = resolve
      }),
  )
  const ui = await mount('darwin', [], configure)
  expect(ui.selects()).toBe(0)
  await ui.click()
  expect(ui.disabled()).toBe(true)
  await ui.click()
  expect(configure).toHaveBeenCalledExactlyOnceWith('mac', '', false)
  await act(async () => release(ok))
  expect(ui.text()).toContain(ok.message)
})
