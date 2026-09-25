/** Install the suite's own Remote namespaces before mounting its settings. */
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context } from '@deepseek-ai/cordis'
import remote from './generated/gateway-remote.mjs'
import * as settings from './client/gateway/index.tsx'
import { SetupScreen } from './client/SetupScreen.tsx'
import type { LoginChoice } from './setup-config.ts'
export const inject = ['remote', 'slots', 'locale', 'configForms']
/** Register remote calls and settings with the same plugin lifecycle.
 * @param ctx - Official browser context.
 * @returns After the Gateway Remote namespace is mounted.
 */
export async function apply(ctx: Context): Promise<void> {
  const dispose = await ctx.remote.$mount(remote)
  ctx.effect(() => dispose)
  ctx.plugin(settings)
  ctx.inject(['remote.oplGatewayAccount', 'remote.oplSearch'], (ctx) => {
    if (location.hash === '#opl-setup') {
      const unwrap = <T,>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      }
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay', id: 'opl-setup', locale: 'settings.oplGateway',
        inject: () => ({
          choose: (choice: LoginChoice) => ctx.configForms.get('opl-suite').set('loginChoice', choice),
          status: async () => unwrap(await ctx.remote.oplGatewayAccount.status()),
          signIn: async (email: string, password: string) => unwrap(await ctx.remote.oplGatewayAccount.signIn(email, password)),
          refresh: async () => unwrap(await ctx.remote.oplGatewayAccount.refresh()),
          signOut: async () => unwrap(await ctx.remote.oplGatewayAccount.signOut()),
        }),
      }, (props) => <SetupScreen {...props} close={() => {}} />))
    }
  })
}
