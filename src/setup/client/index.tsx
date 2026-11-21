import type { Context } from '@deepseek-ai/cordis'
import { useEffect } from 'react'
import { SetupScreen, type SetupActions } from './SetupScreen.tsx'
import { AccountLauncher } from './AccountLauncher.tsx'
import { remoteCall, optionalRemote } from '../../shared/client/remote-call.ts'
import type { OplGatewaySectionInjected } from '../../gateway/client/OplGatewaySection.tsx'
export const inject = ['slots', 'locale', 'remote.oplSetup']
/** Account availability is checked only when choosing Gateway; official setup remains usable. */
export function apply(
  ctx: Context,
  navigation: {
    bindModelNavigation: (navigate: (() => void) | undefined) => void
    bindSettingsNavigation?: (navigate: ((section?: 'engines') => void) | undefined) => void
  },
): void {
  const call = remoteCall(ctx.remote.oplSetup)
  const account = () => {
    const service = optionalRemote(ctx, 'oplGatewayAccount')
    if (!service) throw new Error('OPL Gateway 暂不可用，可选择官方账户或稍后设置。')
    return remoteCall(service)
  }
  const actions: SetupActions & OplGatewaySectionInjected = {
    readSetup: () => call('status'),
    finish: async (choice) => {
      await call('finish', choice)
    },
    startOfficial: async () => {
      await call('official-start')
    },
    cancelOfficial: async () => {
      await call('official-cancel')
    },
    saveOfficialKey: async (key) => {
      await call('official-key', key)
    },
    status: () => account()('status'),
    signIn: (email, password, remember) => account()('signIn', email, password, remember),
    rememberedLogin: () => account()('rememberedLogin'),
    signInRemembered: (email) => account()('signInRemembered', email),
    forgetPassword: () => account()('forgetPassword'),
    refresh: () => account()('refresh'),
    signOut: () => account()('signOut'),
  }
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'opl-setup',
        locale: 'settings.oplGateway',
        inject: () => actions,
      },
      (props) => <SetupScreen {...props} close={() => {}} />,
    ),
  )
  ctx.slots.inject('settings.onboarding', () =>
    ctx.slots.register(
      {
        name: 'settings.onboarding',
        id: 'opl-account',
        order: 100,
        locale: 'settings.oplGateway',
        inject: () => actions,
      },
      (props) =>
        props.explicit ? (
          <SetupScreen {...props} explicit close={props.complete} />
        ) : (
          <SkipAccountStep complete={props.complete} />
        ),
    ),
  )
  ctx.slots.inject('settings.onboarding', () =>
    ctx.slots.register(
      {
        name: 'settings.onboarding',
        id: 'opl-model-navigation',
        order: 101,
      },
      (props) => <SectionNavigationStep {...props} section="models" />,
    ),
  )
  ctx.slots.inject('settings.onboarding', () =>
    ctx.slots.register(
      {
        name: 'settings.onboarding',
        id: 'opl-update-navigation',
        order: 102,
      },
      (props) => <SectionNavigationStep {...props} section="general" />,
    ),
  )
  ctx.slots.inject('settings.onboarding', () =>
    ctx.slots.register(
      { name: 'settings.onboarding', id: 'opl-engine-navigation', order: 103 },
      (props) => <SectionNavigationStep {...props} section="opl-execution" />,
    ),
  )
  ctx.slots.inject('settings.launcher', () =>
    ctx.slots.register(
      {
        name: 'settings.launcher',
        priority: -10,
        locale: 'settings.oplGateway',
        inject: () => ({
          readAccount: actions.status,
          bindModelNavigation: navigation.bindModelNavigation,
          ...(navigation.bindSettingsNavigation
            ? { bindSettingsNavigation: navigation.bindSettingsNavigation }
            : {}),
        }),
      },
      AccountLauncher,
    ),
  )
}
function SkipAccountStep({ complete }: { complete: () => void }) {
  useEffect(complete, [complete])
  return null
}
function SectionNavigationStep({
  complete,
  openSection,
  explicit,
  section,
}: {
  complete: () => void
  openSection: (id: string) => void
  explicit?: boolean
  section: string
}) {
  useEffect(() => {
    complete()
    if (explicit) {
      if (section === 'opl-execution') {
        followEngineUpdates()
        openSection(section)
      } else openSection(section)
    }
  }, [complete, openSection, explicit, section])
  return null
}

/** Keep the requested panel visible while the preceding model catalog fills in. */
function followEngineUpdates() {
  let frame = 0
  let observed: Element | null = null
  let anchoredTop: number | undefined
  const schedule = () => {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      const panel = document.getElementById('opl-engine-updates')
      if (!panel) {
        const toggle = document.getElementById('opl-engine-updates-toggle')
        const group = toggle?.closest('details')
        if (group) group.open = true
        if (toggle?.getAttribute('aria-expanded') === 'false') toggle.click()
        return
      }
      const details = panel.closest('details')
      if (details) details.open = true
      const page = panel.closest('[data-opl-panel="execution"]')
      if (page && page !== observed) {
        observed = page
        sizes.disconnect()
        for (const child of page.children) sizes.observe(child)
      }
      const top = panel.getBoundingClientRect().top
      if (anchoredTop === undefined || Math.abs(top - anchoredTop) > 2) {
        panel.scrollIntoView({ block: 'start', behavior: 'instant' })
        anchoredTop = panel.getBoundingClientRect().top
      }
    })
  }
  const sizes = new ResizeObserver(schedule)
  const mutations = new MutationObserver(schedule)
  mutations.observe(document.body, { childList: true, subtree: true })
  const events = ['wheel', 'touchstart', 'pointerdown', 'keydown']
  const stop = () => {
    clearTimeout(deadline)
    cancelAnimationFrame(frame)
    sizes.disconnect()
    mutations.disconnect()
    for (const event of events) document.removeEventListener(event, stop, true)
  }
  const deadline = setTimeout(stop, 10000)
  for (const event of events)
    document.addEventListener(event, stop, { capture: true, passive: true })
  schedule()
}
