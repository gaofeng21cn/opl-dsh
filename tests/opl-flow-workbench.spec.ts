// @vitest-environment jsdom
import React, { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { createRoot, type Root } from 'react-dom/client'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement('button', props, children),
}))

import { probeOplFlowControlPlane } from '../src/opl-flow/host/probe.ts'
import * as oplFlowClient from '../src/opl-flow/client/index.tsx'
import { OplFlowPanel } from '../src/opl-flow/client/OplFlowPanel.tsx'
import type { OplFlowCall } from '../src/opl-flow/client/types.ts'
import type { OplFlowDashboardEnvelope } from '../src/opl-flow/contracts/index.ts'

class StubSlots extends Service {
  readonly registered: Array<Record<string, unknown>> = []
  constructor(ctx: Context) {
    super(ctx, 'slots')
  }
  inject(_name: string, factory: () => unknown) {
    return factory()
  }
  register(spec: Record<string, unknown>, _component: unknown) {
    this.registered.push(spec)
    return () => {
      const idx = this.registered.indexOf(spec)
      if (idx >= 0) this.registered.splice(idx, 1)
    }
  }
}

class StubService extends Service {
  constructor(ctx: Context, serviceName: string, methods: object = {}) {
    super(ctx, serviceName)
    Object.assign(this, methods)
  }
}

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.()
  }
})

describe('OPL Flow conditional DSH workbench', () => {
  it('probeOplFlowControlPlane stays silent and unmounted without valid instance/script', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'opl-flow-dsh-probe-'))
    cleanups.push(() => rmSync(tmp, { recursive: true, force: true }))

    const missing = await probeOplFlowControlPlane({ homeDir: tmp })
    expect(missing.available).toBe(false)

    const configDir = join(tmp, '.config', 'opl-flow')
    const ledgerDir = join(tmp, 'ledger')
    const scriptsDir = join(tmp, 'workspace', 'opl-flow', 'scripts')
    mkdirSync(configDir, { recursive: true })
    mkdirSync(ledgerDir, { recursive: true })
    mkdirSync(scriptsDir, { recursive: true })

    writeFileSync(join(configDir, 'instance.json'), '{not-json')
    expect((await probeOplFlowControlPlane({ homeDir: tmp })).available).toBe(false)

    writeFileSync(
      join(configDir, 'instance.json'),
      JSON.stringify({ instance_name: 'demo', instance_root: ledgerDir }),
    )
    expect((await probeOplFlowControlPlane({ homeDir: tmp })).available).toBe(false)

    const scriptPath = join(scriptsDir, 'opl_app_contribution.py')
    writeFileSync(scriptPath, '#!/usr/bin/env python3\n')
    const ready = await probeOplFlowControlPlane({ homeDir: tmp })
    expect(ready).toMatchObject({
      available: true,
      instanceName: 'demo',
      scriptPath,
    })
  })

  it('registers zero sidebar/main slots when unavailable and mounts order-34 slots when available', async () => {
    for (const available of [false, true]) {
      const ctx = new Context()
      cleanups.push(() => ctx.fiber.dispose())
      let slots!: StubSlots
      await ctx.plugin({
        name: 'fixture',
        apply(provider: Context) {
          slots = new StubSlots(provider)
          new StubService(provider, 'locale', {
            register: () => () => {},
            bind: () => (key: string) => (key === 'panel' ? 'OPL Flow 总控' : key),
            getSnapshot: () => 'zh-CN',
          })
          new StubService(provider, 'uiWorkspace', {
            openSession: vi.fn(),
            startSession: vi.fn(),
          })
        },
      })

      const call = vi.fn(async (method: string) => {
        if (method === 'availability') return { available }
        throw new Error(`unexpected call ${method}`)
      }) as unknown as OplFlowCall

      await ctx.plugin(oplFlowClient, { call })
      if (!available) {
        expect(slots.registered).toHaveLength(0)
      } else {
        const nav = slots.registered.find(
          (item) => item.name === 'sidebar.panellist' && item.id === 'opl-flow',
        )
        const main = slots.registered.find(
          (item) => item.name === 'main' && item.key === 'opl-flow',
        )
        expect(nav).toMatchObject({ id: 'opl-flow', order: 34 })
        expect((nav?.label as () => string)()).toBe('OPL Flow 总控')
        expect(main).toBeDefined()
        await ctx.fiber.dispose()
        expect(slots.registered).toHaveLength(0)
      }
    }
  })

  it('OplFlowPanel enforces jump_mode (openSession vs explicit startSession) and executes confirm-guarded actions', async () => {
    const dashboard: OplFlowDashboardEnvelope = {
      ok: true,
      state: 'ready',
      data: {
        schema: 'opl-flow.decision.v1',
        instance_name: 'demo-host',
        service: { installed: true, running: true, bridge: 'auto' },
        counts: {
          needs_action: 2,
          safe_to_archive: 1,
          active_objectives: 0,
          active_sessions: 1,
          blocked: 0,
          backlog: 0,
          pending_events: 0,
        },
        inbox: {
          needs_action: [
            {
              bead_id: 'opl-10',
              title: 'DSH native objective',
              execution_carrier: 'dsh',
              session_id: 'sess-dsh-10',
              jump_mode: 'native_switch',
              next_action: 'Switch back into DSH session',
            },
            {
              bead_id: 'opl-11',
              title: 'Codex held workspace',
              execution_carrier: 'codex',
              workspace_path: '/tmp/ws-codex',
              jump_mode: 'external_focus_only',
              first_blocker: 'Held in Codex app',
            },
          ],
          safe_to_archive: [
            {
              bead_id: 'opl-12',
              title: 'Archive ready objective',
              jump_mode: 'launch_new',
              user_approval_required: true,
            },
          ],
          active_objectives: [],
          blocked: [],
          backlog: [],
          pending_events: [],
        },
        active_sessions: {
          sessions: [],
          active_workspace_occupants: [
            { workspace_label: 'ws-codex', carrier: 'codex', session_ref: 'codex:t1' },
          ],
        },
      },
    }

    const calls: Array<{ method: string; args: unknown[] }> = []
    const call = (async (method: string, ...args: unknown[]) => {
      calls.push({ method, args })
      if (method === 'dashboard') return dashboard
      return { ok: true, message: `ok:${method}` }
    }) as unknown as OplFlowCall

    const openSession = vi.fn()
    const startSession = vi.fn()
    const host = document.createElement('div')
    document.body.append(host)
    const reactRoot: Root = createRoot(host)
    cleanups.push(async () => {
      await act(async () => reactRoot.unmount())
      host.remove()
    })

    await act(async () => {
      reactRoot.render(
        React.createElement(OplFlowPanel, {
          call,
          locale: 'zh',
          openSession,
          startSession,
        }),
      )
    })

    expect(host.textContent).toContain('OPL Flow 总控')
    expect(host.textContent).toContain('当前由 Codex 持有')

    const findButton = (text: string) =>
      Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes(text))

    await act(async () => {
      findButton('切换 DSH 会话')!.click()
    })
    expect(openSession).toHaveBeenCalledWith('sess-dsh-10')

    await act(async () => {
      findButton('新建 DSH 会话')!.click()
    })
    expect(startSession).toHaveBeenCalledWith('/tmp/ws-codex')

    await act(async () => {
      findButton('立即评估 (Tick)')!.click()
    })
    expect(calls.some((c) => c.method === 'tick')).toBe(true)

    await act(async () => {
      findButton('待批归档')!.click()
    })
    await act(async () => {
      findButton('批准归档')!.click()
    })
    await act(async () => {
      findButton('确认归档')!.click()
    })
    expect(
      calls.some(
        (c) => c.method === 'approve' && (c.args[0] as { confirmed?: boolean })?.confirmed === true,
      ),
    ).toBe(true)
  })
})
