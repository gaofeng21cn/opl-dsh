import { JSDOM } from 'jsdom'
import { act, createElement, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  executionSettingsEn,
  executionSettingsZh,
  type ExecutionSettingsLocaleKey,
  type ExecutionSettingsT,
} from '../../src/execution/client/execution-settings-locales.ts'
import {
  collaborationEn,
  collaborationZh,
  type CollaborationLocaleKey,
  type CollaborationT,
} from '../../src/collaboration/client/collaboration-locales.ts'
import type {
  CoordinationCall,
  ExecutionCall,
  RoleExecutionCall,
} from '../../src/shared/client/remote-call.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({
    children,
    type = 'button',
    ...props
  }: { children?: ReactNode } & Record<string, unknown>) =>
    createElement('button', { ...props, type }, children),
  IconChevronDownOutlineRegular: () => null,
  IconChevronRightOutlineRegular: (props: Record<string, unknown>) =>
    createElement('span', { ...props, 'aria-hidden': 'true' }),
  Menu: ({ anchor }: { anchor: ReactNode }) => createElement('div', null, anchor),
  StateDot: (props: Record<string, unknown>) =>
    createElement('span', { ...props, 'aria-hidden': 'true' }),
  Switch: ({
    label,
    checked,
    onChange,
    ...props
  }: {
    label?: string
    checked?: boolean
    onChange?: (checked: boolean) => void
  } & Record<string, unknown>) =>
    createElement(
      'button',
      {
        ...props,
        role: 'switch',
        'aria-label': label,
        'aria-checked': checked,
        onClick: () => onChange?.(!checked),
      },
      label,
    ),
}))

function formatTemplate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, name: string) =>
    name in params ? String(params[name]) : `{${name}}`,
  )
}

const englishExecutionT: ExecutionSettingsT = (key, params) =>
  formatTemplate(executionSettingsEn[key], params)

const englishCollaborationT: CollaborationT = (key, params) =>
  formatTemplate(collaborationEn[key], params)

function placeholders(template: string): string[] {
  return [...template.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]!).sort()
}

describe('Execution & collaboration settings locales', () => {
  it('keeps zh and en dictionaries complete with matching keys and placeholders', () => {
    const execZhKeys = Object.keys(executionSettingsZh).sort()
    const execEnKeys = Object.keys(executionSettingsEn).sort()
    expect(execEnKeys).toEqual(execZhKeys)
    for (const key of execZhKeys as ExecutionSettingsLocaleKey[]) {
      expect(executionSettingsZh[key].trim().length, `empty zh: ${key}`).toBeGreaterThan(0)
      expect(executionSettingsEn[key].trim().length, `empty en: ${key}`).toBeGreaterThan(0)
      expect(placeholders(executionSettingsEn[key]), `placeholders mismatch: ${key}`).toEqual(
        placeholders(executionSettingsZh[key]),
      )
    }

    const collabZhKeys = Object.keys(collaborationZh).sort()
    const collabEnKeys = Object.keys(collaborationEn).sort()
    expect(collabEnKeys).toEqual(collabZhKeys)
    for (const key of collabZhKeys as CollaborationLocaleKey[]) {
      expect(collaborationZh[key].trim().length, `empty zh: ${key}`).toBeGreaterThan(0)
      expect(collaborationEn[key].trim().length, `empty en: ${key}`).toBeGreaterThan(0)
      expect(placeholders(collaborationEn[key]), `placeholders mismatch: ${key}`).toEqual(
        placeholders(collaborationZh[key]),
      )
    }
  })

  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!()
  })

  it('renders ExecutionSettings and CoordinationSection in English without untranslated CJK chrome', async () => {
    const dom = new JSDOM('<div id="root"></div>')
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      IS_REACT_ACT_ENVIRONMENT: true,
    })
    const { createRoot } = await import('react-dom/client')
    const { ExecutionSettings } = await import('../../src/execution/client/ExecutionSettings.tsx')
    const { CoordinationSection } =
      await import('../../src/collaboration/client/CoordinationSection.tsx')

    const modelRef = { provider: 'opl-gateway', model: 'codex::gpt-5.3' }
    const unavailableRef = { provider: 'opl-gateway', model: 'claude::sonnet' }
    const executionCall = (async (method: string) => {
      if (method === 'harness-installations')
        return [
          {
            id: 'dsh',
            name: 'DSH',
            installed: true,
            runnable: true,
            instructions: 'Built-in engine',
            website: '',
            definition: { id: 'dsh', name: 'DSH', kind: 'dsh', adapter: 'native-session' },
          },
          {
            id: 'codex',
            name: 'Codex CLI',
            installed: true,
            runnable: true,
            detectedBy: 'shell-path',
            version: '1.0.0',
            path: '/usr/local/bin/codex',
            instructions: 'External Codex engine',
            website: 'https://example.com',
            definition: { id: 'codex', name: 'Codex CLI', kind: 'acp', command: 'codex' },
          },
          {
            id: 'minimax-code',
            name: 'MiniMax Code',
            installed: false,
            runnable: false,
            instructions: 'Install MiniMax CLI',
            website: '',
            maintenanceAction: 'install',
            definition: { id: 'minimax-code', name: 'MiniMax Code', kind: 'acp', command: 'mcode' },
          },
        ]
      if (method === 'engine-updates')
        return { enabled: true, mode: 'notify', checking: false, items: [] }
      if (method === 'catalog')
        return {
          version: 2,
          models: [
            { ref: modelRef, name: 'GPT 5.3', source: 'OPL Gateway', available: true },
            {
              ref: unavailableRef,
              name: 'Claude Sonnet',
              source: 'OPL Gateway',
              available: false,
              unavailableKind: 'disabled',
              reason: 'Provider disabled',
            },
          ],
          harnesses: [
            { id: 'dsh', name: 'DSH', kind: 'dsh', adapter: 'native-session' },
            { id: 'codex', name: 'Codex CLI', kind: 'acp', command: 'codex' },
          ],
          combinations: [
            {
              id: 'combo-1',
              name: 'GPT 5.3 + Codex CLI',
              modelRef,
              harnessRef: 'codex',
              permissionPolicy: 'workspace',
              isDefault: true,
              enabled: true,
            },
            {
              id: 'combo-2',
              name: 'Claude Sonnet + DSH',
              modelRef: unavailableRef,
              harnessRef: 'dsh',
              permissionPolicy: 'full-access',
              isDefault: false,
              enabled: true,
            },
          ],
          recommendations: [{ modelRef, harnessRef: 'dsh', name: 'GPT 5.3 + DSH' }],
          supportedPairings: [
            {
              modelRef,
              harnessRefs: ['codex', 'dsh'],
              permissionPolicies: { codex: ['workspace'], dsh: ['workspace'] },
            },
          ],
        }
      if (method === 'combinations')
        return [
          { id: 'combo-1', available: true },
          { id: 'combo-2', available: false },
        ]
      if (method === 'execution-limits')
        return { enabled: false, firstProgressMs: 90_000, idleProgressMs: 90_000 }
      if (method === 'cooperation-settings')
        return { autoReview: true, maxRevisions: 2, externalCodex: true }
      throw new Error(`unexpected execution RPC ${method}`)
    }) as unknown as ExecutionCall

    const coordinationCall = (async (method: string) => {
      if (method === 'coordination-status')
        return {
          installed: true,
          autoStart: true,
          wakeTransport: 'codex-queue',
          wakeExecution: 'native',
          wakeExecutable: '/usr/local/bin/codex',
          wakeDistro: '',
        }
      if (method === 'coordinator-hooks')
        return { installed: true, registered: 1, verified: 1, trusted: 1, disabled: 0, total: 1 }
      throw new Error(`unexpected coordination RPC ${method}`)
    }) as unknown as CoordinationCall

    const roleCall = (async (method: string) => {
      if (method === 'catalog')
        return {
          presets: [{ id: 'architect', name: 'Architect' }],
          combinations: [{ id: 'combo-1', name: 'GPT 5.3 + Codex CLI', available: true }],
          bindings: {},
        }
      throw new Error(`unexpected role RPC ${method}`)
    }) as unknown as RoleExecutionCall

    const container = dom.window.document.getElementById('root')!
    const root = createRoot(container)
    cleanups.push(async () => {
      await act(async () => root.unmount())
      dom.window.close()
    })

    const minimaxSnapshot = {
      status: 'ready' as const,
      value: { minimaxCodeEnabled: true },
      writable: false,
    }
    const minimax = {
      form: {
        getSnapshot: () => minimaxSnapshot,
        subscribe: () => () => {},
      },
      t: ((key: string) => key) as never,
    }

    await act(async () => {
      root.render(
        createElement(ExecutionSettings, {
          call: executionCall,
          minimax,
          t: englishExecutionT,
          collaboration: createElement(CoordinationSection, {
            embedded: true,
            call: coordinationCall,
            executionCall,
            roleCall,
            t: englishCollaborationT,
          }),
        }),
      )
    })

    const renderedText = container.textContent ?? ''
    expect(renderedText).toContain('Engines & Team')
    expect(renderedText).toContain('Re-detect')
    expect(renderedText).toContain('More engines')
    expect(renderedText).toContain('Save selection (1)')
    expect(renderedText).toContain('Clear all')
    expect(renderedText).toContain('Executable path')
    expect(renderedText).toContain('Save proxy')
    expect(renderedText).toContain('Wait & timeout limits')
    expect(renderedText).toContain('In-app collaboration')
    expect(renderedText).toContain('Codex task delegation')
    expect(renderedText).toContain('Role default combinations')
    expect(renderedText).toContain('1/1 Hooks trusted')
    expect(renderedText).not.toMatch(/[\u4e00-\u9fff]/)
  })
})
