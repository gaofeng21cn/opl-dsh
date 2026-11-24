// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import {
  AntigravityAccountCard,
  antigravityAccountZh,
} from '../../src/execution/client/AntigravityAccountCard.tsx'

it('opens the official login only on request and refreshes the Google account model list', async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce({ status: 'signed-out', models: [] })
    .mockResolvedValueOnce({ status: 'ready', models: ['account-model'] })
  const login = vi.fn().mockResolvedValue({ status: 'signing-in', models: [] })
  const container = document.createElement('div')
  const root = createRoot(container)
  const button = (text: string) =>
    [...container.querySelectorAll('button')].find((b) => b.textContent === text)!
  try {
    await act(async () =>
      root.render(
        <AntigravityAccountCard
          t={(key) => antigravityAccountZh[key]}
          read={read}
          login={login}
          cancel={vi.fn()}
        />,
      ),
    )
    expect(read).not.toHaveBeenCalled()
    await act(async () => button('编辑').click())
    expect(container.textContent).toContain('未登录')
    expect(login).not.toHaveBeenCalled()
    await act(async () => button('使用 Google 账号登录').click())
    expect(login).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain(antigravityAccountZh.opened)
    expect(button('使用 Google 账号登录')).toBeUndefined()
    await act(async () => button('刷新状态').click())
    expect(container.textContent).toContain('account-model')
    expect(container.textContent).not.toContain(antigravityAccountZh.opened)
    expect(button('使用 Google 账号登录')).toBeUndefined()
  } finally {
    act(() => root.unmount())
  }
})

it('polls while open and awaiting authorization, and ignores a late poll after cancellation', async () => {
  vi.useFakeTimers()
  const started = { status: 'signing-in' as const, models: [] }
  const off = { status: 'signed-out' as const, models: [] }
  let resolveOld!: (state: typeof started) => void
  const read = vi
    .fn()
    .mockResolvedValueOnce(started)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve
        }),
    )
    .mockResolvedValueOnce({ status: 'ready', models: ['confirmed'] })
  const login = vi.fn().mockResolvedValue(started)
  const cancel = vi.fn().mockResolvedValue(off)
  const container = document.createElement('div')
  const root = createRoot(container)
  const button = (text: string) =>
    [...container.querySelectorAll('button')].find((b) => b.textContent === text)!
  try {
    await act(async () =>
      root.render(
        <AntigravityAccountCard
          t={(key) => antigravityAccountZh[key]}
          read={read}
          login={login}
          cancel={cancel}
        />,
      ),
    )
    await act(async () => button('编辑').click())
    await act(async () => vi.advanceTimersByTimeAsync(2000))
    expect(read).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('等待网页授权')
    await act(async () => button('取消本次登录').click())
    expect(cancel).toHaveBeenCalledTimes(1)
    await act(async () => resolveOld(started))
    expect(container.textContent).toContain('未登录')
    await act(async () => button('使用 Google 账号登录').click())
    await act(async () => vi.advanceTimersByTimeAsync(2000))
    expect(container.textContent).toContain('confirmed')
    await act(async () => vi.advanceTimersByTimeAsync(4000))
    expect(read).toHaveBeenCalledTimes(3)
    await act(async () => button('编辑').click())
    await act(async () => vi.advanceTimersByTimeAsync(4000))
    expect(read).toHaveBeenCalledTimes(3)
  } finally {
    act(() => root.unmount())
    vi.useRealTimers()
  }
})
