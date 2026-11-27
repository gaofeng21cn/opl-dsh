// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, createElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { zh } from '../../src/gateway/client/locales.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Modal: ({
    open,
    title,
    className,
    children,
  }: {
    open: boolean
    title: string
    className?: string
    children?: ReactNode
  }) =>
    open
      ? createElement('div', { role: 'dialog', 'aria-label': title, className }, children)
      : null,
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: {
    children?: ReactNode
    variant?: string
    size?: string
  } & Record<string, unknown>) => createElement('button', { type: 'button', ...props }, children),
}))

const { SetupScreen } = await import('../../src/setup/client/SetupScreen.tsx')

const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT
globalThis.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

it('keeps SetupScreen dialog bounded inside Modal padding box and preserves flex column fields', async () => {
  const css = readFileSync(
    join(import.meta.dirname, '../../src/setup/client/SetupScreen.module.css'),
    'utf8',
  )
  expect(css).toMatch(/\.setup\[role='dialog'\][^}]*max-height:\s*100%/s)
  expect(css).toMatch(/\.setup\[role='dialog'\][^}]*max-width:\s*100%/s)
  expect(css).toMatch(/\.setup\[role='dialog'\][^}]*overflow-x:\s*hidden/s)
  expect(css).toMatch(/\.field\s*\{[^}]*display:\s*flex;\s*flex-direction:\s*column/s)
  expect(css).toMatch(/\.loginCard\s*\{[^}]*display:\s*flex;\s*flex-direction:\s*column/s)

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  cleanups.push(async () => {
    await act(async () => root.unmount())
  })

  const props = {
    explicit: true,
    close: vi.fn(),
    readSetup: vi.fn(async () => ({
      completed: false,
      choice: 'undecided' as const,
      gatewayReady: false,
      officialProvider: false,
    })),
    finish: vi.fn(async () => {}),
    startOfficial: vi.fn(async () => {}),
    cancelOfficial: vi.fn(async () => {}),
    saveOfficialKey: vi.fn(async () => {}),
    status: vi.fn(async () => ({
      phase: 'signed-out' as const,
      endpoint: 'https://gateway.example/v1',
      keyReady: false,
    })),
    signIn: vi.fn(async () => ({
      status: {
        phase: 'connected' as const,
        endpoint: 'https://gateway.example/v1',
        keyReady: true,
      },
      createdKey: false,
    })),
    refresh: vi.fn(async () => ({
      phase: 'signed-out' as const,
      endpoint: 'https://gateway.example/v1',
      keyReady: false,
    })),
    signOut: vi.fn(async () => ({
      phase: 'signed-out' as const,
      endpoint: 'https://gateway.example/v1',
      keyReady: false,
    })),
    t: ((key: keyof typeof zh) => zh[key]) as never,
  }

  await act(async () => {
    root.render(createElement(SetupScreen, props as never))
  })
  const gatewayChoice = [...container.querySelectorAll('button')].find((btn) =>
    btn.textContent?.includes(zh.setupGateway),
  )!
  expect(gatewayChoice).toBeDefined()
  await act(async () => {
    gatewayChoice.click()
  })
  const dialog = container.querySelector('[role="dialog"]')!
  const emailInput = dialog.querySelector('input[type="email"]')
  const passwordInput = dialog.querySelector('input[type="password"]')
  expect(dialog.querySelector('form')).not.toBeNull()
  expect(emailInput).not.toBeNull()
  expect(passwordInput).not.toBeNull()
  expect(emailInput?.closest('label')).not.toBeNull()
  expect(passwordInput?.closest('label')).not.toBeNull()
})
