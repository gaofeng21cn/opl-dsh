import { HarnessPanel } from './client/HarnessPanel.tsx'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { useEffect } from 'react'
import { CoordinationSection } from './client/CoordinationSection.tsx'
/** Install the suite's own Remote namespaces before mounting its settings. */
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context } from '@deepseek-ai/cordis'
import remote from './generated/gateway-remote.mjs'
import * as settings from './client/gateway/index.tsx'
import { AccountLauncher } from './client/AccountLauncher.tsx'
import { SetupScreen } from './client/SetupScreen.tsx'
import type { SetupStatus } from './setup-types.ts'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
export const inject = ['remote', 'slots', 'locale', 'configForms', 'connection', 'layout']
/** Register remote calls and settings with the same plugin lifecycle.
 * @param ctx - Official browser context.
 * @returns After the Gateway Remote namespace is mounted.
 */
export async function apply(ctx: Context): Promise<void> {
  const dispose = await ctx.remote.$mount(remote)
  ctx.effect(() => dispose)
  ctx.plugin(settings)
  ctx.inject(['remote.oplGatewayAccount'], (ctx) => {
    if ('dshDesktop' in globalThis || location.hash === '#opl-setup') {
      const unwrap = <T,>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      }
      const setup = async <T,>(endpoint: string, payload: unknown = null): Promise<T> => unwrap(await (ctx.get('connection') as ConnectionHandle).rpc.call('/api', 'oplSetup/' + endpoint, payload)) as T
      const coordination = (action: string, value?: unknown) => setup(action,value)
      const harnessCall = <T,>(method:string,input:unknown={}) => setup<T>('harness',{method,input})
      ctx.slots.inject('main', () => ctx.slots.register({name:'main',key:'opl-harness',inject:()=>({call:harnessCall,close:()=>ctx.layout.selectPanel(null)})}, HarnessPanel))
      ctx.slots.inject('settings.section', () => ctx.slots.register({name:'settings.section',id:'opl-harness',order:33,label:()=> '执行组合',inject:()=>({call:harnessCall})}, HarnessPanel))
      ctx.slots.inject('settings.section', () => ctx.slots.register({name:'settings.section',id:'opl-codex',order:32,label:()=> 'Codex 协作',inject:()=>({call:coordination})}, CoordinationSection))
      const accountActions = {
          readSetup: () => setup<SetupStatus>('status'),
          finish: (choice: 'gateway' | 'official' | 'later') => setup<void>('finish', choice),
          startOfficial: () => setup<void>('official-start'),
          cancelOfficial: () => setup<void>('official-cancel'),
          saveOfficialKey: (key: string) => setup<void>('official-key', key),
          status: async () => unwrap(await ctx.remote.oplGatewayAccount.status()),
          signIn: async (email: string, password: string) => unwrap(await ctx.remote.oplGatewayAccount.signIn(email, password)),
          refresh: async () => unwrap(await ctx.remote.oplGatewayAccount.refresh()),
          signOut: async () => unwrap(await ctx.remote.oplGatewayAccount.signOut()),
        }
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay', id: 'opl-setup', locale: 'settings.oplGateway',
        inject: () => accountActions,
      }, props => <SetupScreen {...props} close={() => {}} />))
      ctx.slots.inject('settings.onboarding', () => ctx.slots.register({
        name: 'settings.onboarding', id: 'opl-account', order: 100, locale: 'settings.oplGateway',
        inject: () => accountActions,
      }, props => props.explicit
        ? <SetupScreen {...props} explicit close={props.complete} />
        : <SkipAccountStep complete={props.complete} />))
      ctx.slots.inject('settings.launcher', () => ctx.slots.register({
        name: 'settings.launcher', priority: -10, locale: 'settings.oplGateway',
        inject: () => ({ readSetup: accountActions.readSetup, openHarness: () => ctx.layout.selectPanel('opl-harness' as MainPanelId) }),
      }, AccountLauncher))
    }
  })
}

/** First-run remains owned by the existing overlay; the extra step is explicit-only. */
function SkipAccountStep({ complete }: { complete: () => void }) {
  useEffect(complete, [complete])
  return null
}
