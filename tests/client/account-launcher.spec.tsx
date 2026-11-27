import { createTestDom } from './dom.ts'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { GatewayAccountStatus } from '../../src/gateway/contracts/account.ts'
import { notifyAccountChanged } from '../../src/gateway/client/account-changes.ts'
import { zh } from '../../src/gateway/client/locales.ts'

const menu = vi.hoisted(() => ({ select: undefined as ((id: string) => void) | undefined }))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Menu: ({ anchor, onSelect }: { anchor: ReactNode; onSelect: (id: string) => void }) => {
    menu.select = onSelect
    return anchor
  },
  IconUserOutlineMedium: () => null,
  IconEllipsisOutlineMedium: () => null,
  IconSettingsOutlineMedium: () => null,
}))
import type { TrailingNoticeSource } from '../../src/setup/client/AccountLauncher.tsx'
const { AccountLauncher } = await import('../../src/setup/client/AccountLauncher.tsx')
const roots: Root[] = []
afterEach(async () => {
  await act(async () => roots.splice(0).forEach((root) => root.unmount()))
})
const status = (email?: string, displayName?: string): GatewayAccountStatus => ({
  phase: email || displayName ? 'connected' : 'signed-out',
  endpoint: 'https://fixture.invalid',
  keyReady: true,
  ...(email || displayName
    ? {
        account: {
          ...(email ? { email } : {}),
          ...(displayName ? { displayName } : {}),
        } as NonNullable<GatewayAccountStatus['account']>,
      }
    : {}),
})
async function mount(
  readAccount: () => Promise<GatewayAccountStatus>,
  wide = true,
  trailingNotice?: TrailingNoticeSource,
) {
  const dom = createTestDom()
  const container = dom.container()
  const root = createRoot(container as unknown as HTMLElement)
  roots.push(root)
  const openSettings = vi.fn()
  const openOnboarding = vi.fn()
  const props = {
    wide,
    settingsOpen: false,
    readAccount,
    bindSettingsNavigation:
      vi.fn<
        (navigate: ((section?: 'general' | 'engines' | 'gateway') => void) | undefined) => void
      >(),
    ...(trailingNotice ? { trailingNotice } : {}),
    openSettings,
    openOnboarding,
    t: (key: keyof typeof zh) => zh[key],
  }
  await act(async () => root.render(<AccountLauncher {...props} />))
  return { root, container, props, openSettings, openOnboarding }
}

it('shows the OPL email and retains settings and account navigation', async () => {
  const email = 'long.account.address@example.test'
  const view = await mount(async () => status(email))
  expect(view.container.textContent).toBe(email)
  expect(view.container.firstChild?.getAttribute('title')).toBe(email)
  await act(async () => menu.select!('settings'))
  expect(view.openSettings).toHaveBeenCalledOnce()
  await act(async () => menu.select!('account'))
  expect(view.openOnboarding).toHaveBeenCalledWith('opl-account')
})

it('does not infer a login from ready model credentials', async () => {
  const view = await mount(async () => status())
  expect(view.container.textContent).toBe('未登录')
})

it('routes settings navigation directly through official openSettings and releases on unmount', async () => {
  const view = await mount(async () => status())
  const navigate = view.props.bindSettingsNavigation.mock.calls.at(-1)?.[0]
  expect(navigate).toBeTypeOf('function')
  navigate!()
  expect(view.openSettings).toHaveBeenCalledWith('general')
  navigate!('engines')
  expect(view.openSettings).toHaveBeenCalledWith('opl-execution')
  navigate!('gateway')
  expect(view.openSettings).toHaveBeenCalledWith('opl-gateway')
  expect(view.openOnboarding).not.toHaveBeenCalled()
  await act(async () => view.root.unmount())
  expect(view.props.bindSettingsNavigation).toHaveBeenLastCalledWith(undefined)
})

it('updates after account changes and ignores an earlier pending read', async () => {
  let resolveOld!: (value: GatewayAccountStatus) => void
  const read = vi
    .fn<() => Promise<GatewayAccountStatus>>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve
        }),
    )
    .mockResolvedValueOnce(status('current@example.test'))
    .mockResolvedValueOnce(status())
  const view = await mount(read)
  await act(async () => notifyAccountChanged())
  expect(view.container.textContent).toBe('current@example.test')
  await act(async () => resolveOld(status('previous@example.test')))
  expect(view.container.textContent).toBe('current@example.test')
  await act(async () => notifyAccountChanged())
  expect(view.container.textContent).toBe('未登录')
})

it('keeps the email as the collapsed launcher tooltip', async () => {
  const view = await mount(async () => status('collapsed@example.test'), false)
  expect(view.container.textContent).toBe('')
  expect(view.container.firstChild?.getAttribute('title')).toBe('collapsed@example.test')
})

it('clears stale identity on a failed read and unsubscribes on unmount', async () => {
  const read = vi.fn(async () => status('account@example.test'))
  const view = await mount(read)
  read.mockRejectedValueOnce(new Error('disconnected'))
  await act(async () => notifyAccountChanged())
  expect(view.container.textContent).toBe('连接异常')
  await act(async () => view.root.unmount())
  const calls = read.mock.calls.length
  notifyAccountChanged()
  expect(read).toHaveBeenCalledTimes(calls)
})

it('prefers Gateway displayName over email and keeps email in the tooltip', async () => {
  const view = await mount(async () => status('gf@fenggaolab.org', '高峰'))
  expect(view.container.textContent).toBe('高峰')
  expect(view.container.firstChild?.getAttribute('title')).toBe('高峰 (gf@fenggaolab.org)')
})

it('renders inline trailing update notice only when wide and updates on change', async () => {
  let current: ((wide: boolean) => ReactNode) | undefined
  const listeners = new Set<() => void>()
  const source: TrailingNoticeSource = {
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  const view = await mount(async () => status('gf@fenggaolab.org', '高峰'), true, source)
  expect(view.container.textContent).toBe('高峰')
  await act(async () => {
    current = (wide) => (wide ? <button type="button">更新</button> : null)
    for (const listener of listeners) listener()
  })
  expect(view.container.textContent).toBe('高峰更新')
  const collapsed = await mount(async () => status('gf@fenggaolab.org', '高峰'), false, source)
  expect(collapsed.container.textContent).toBe('')
})
