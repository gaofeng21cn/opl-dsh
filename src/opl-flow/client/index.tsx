import { useSyncExternalStore, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { OplFlowPanel } from './OplFlowPanel.tsx'
import type { OplFlowCall } from './types.ts'

export const OPL_FLOW_LOCALE_NS = 'oplFlow'
export const OPL_FLOW_PANEL_ID = 'opl-flow'

export const oplFlowZh = {
  panel: 'OPL Flow 总控',
}

export const oplFlowEn = {
  panel: 'OPL Flow',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    oplFlow: keyof typeof oplFlowZh
  }
}

export interface OplFlowClientConfig {
  call: OplFlowCall
}

export const name = 'opl-flow-client'
export const inject = ['slots', 'locale', 'uiWorkspace']

function OplFlowPanelIcon({ size }: { size: number }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="3.5" cy="4" r="1.5" />
      <circle cx="12.5" cy="4" r="1.5" />
      <circle cx="8" cy="12" r="1.5" />
      <path d="M5 4h6M4.3 5.3L7.2 10.6M11.7 5.3L8.8 10.6" />
    </svg>
  )
}

type ReactiveLocale = {
  getSnapshot?: () => unknown
  subscribe?: (listener: () => void) => () => void
  bind?: (ns: string) => (key: 'panel') => string
}

const noopSubscribe = () => () => {}
const staticLocale = () => null

function detectLocaleTag(localeService: ReactiveLocale): 'zh' | 'en' {
  const snap = localeService.getSnapshot?.()
  const raw =
    typeof snap === 'string'
      ? snap
      : snap && typeof snap === 'object' && 'locale' in snap
        ? String((snap as { locale?: unknown }).locale ?? '')
        : typeof navigator !== 'undefined'
          ? navigator.language
          : 'zh'
  return raw.toLowerCase().startsWith('en') ? 'en' : 'zh'
}

function OplFlowPanelHost({
  call,
  localeService,
  openSession,
  startSession,
}: {
  call: OplFlowCall
  localeService: ReactiveLocale
  openSession: (sessionId: string) => void
  startSession: () => void
}): ReactNode {
  useSyncExternalStore(
    typeof localeService.subscribe === 'function'
      ? (listener) => localeService.subscribe!(listener)
      : noopSubscribe,
    typeof localeService.getSnapshot === 'function'
      ? () => localeService.getSnapshot!()
      : staticLocale,
    staticLocale,
  )
  return (
    <OplFlowPanel
      call={call}
      locale={detectLocaleTag(localeService)}
      openSession={openSession}
      startSession={startSession}
    />
  )
}

export async function apply(ctx: Context, { call }: OplFlowClientConfig): Promise<void> {
  let disposed = false
  let disposeSidebar: (() => void) | undefined
  let disposeMain: (() => void) | undefined
  ctx.effect(() => () => {
    disposed = true
    disposeSidebar?.()
    disposeSidebar = undefined
    disposeMain?.()
    disposeMain = undefined
  })

  let available = false
  try {
    const verdict = await call('availability')
    available = verdict?.available === true
  } catch {
    available = false
  }
  if (disposed || !available) {
    return
  }

  ctx.effect(() => ctx.locale.register(OPL_FLOW_LOCALE_NS, { zh: oplFlowZh, en: oplFlowEn }))
  const t =
    typeof ctx.locale.bind === 'function'
      ? ctx.locale.bind(OPL_FLOW_LOCALE_NS)
      : (key: 'panel') => oplFlowZh[key]
  const localeService = ctx.locale as unknown as ReactiveLocale

  const sidebarDisposer = ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: OPL_FLOW_PANEL_ID,
        order: 34,
        label: () => t('panel'),
      },
      OplFlowPanelIcon,
    ),
  )
  const mainDisposer = ctx.slots.inject('main', () =>
    ctx.slots.register(
      {
        name: 'main',
        key: OPL_FLOW_PANEL_ID,
      },
      () => (
        <OplFlowPanelHost
          call={call}
          localeService={localeService}
          openSession={(sessionId) => ctx.uiWorkspace.openSession(sessionId as SessionId)}
          startSession={() => ctx.uiWorkspace.startSession()}
        />
      ),
    ),
  )
  if (disposed) {
    sidebarDisposer?.()
    mainDisposer?.()
    return
  }
  disposeSidebar = sidebarDisposer
  disposeMain = mainDisposer
}
