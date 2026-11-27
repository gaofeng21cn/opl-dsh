import { SETTINGS_ORDER } from '../../shared/client/settings-navigation.ts'
/** Gateway account and model settings mount into one unified OPL Gateway page. */
import type { Context } from '@deepseek-ai/cordis'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { OplGatewaySection, type OplGatewaySectionInjected } from './OplGatewaySection.tsx'
import { en, zh, type OplGatewayLocaleKey } from './locales.ts'
import { remoteCall, optionalRemote } from '../../shared/client/remote-call.ts'
import settingsCss from '../../shared/client/SettingsSection.module.css'
export type { OplGatewaySectionInjected, OplGatewaySectionProps } from './OplGatewaySection.tsx'
export type { OplGatewayLocaleKey } from './locales.ts'
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.oplGateway': OplGatewayLocaleKey
  }
}
const NS = 'settings.oplGateway'
export const inject = ['slots', 'locale', 'remote']

function OplGatewayModelsFooter({
  t,
  openGateway,
}: PropsLocale<'settings.oplGateway'> & { openGateway?: () => void }) {
  return (
    <div className={settingsCss.modelsFooterCard} data-opl-panel="gateway-models-footer">
      <div className={settingsCss.identity}>
        <strong>{t('modelsFooterTitle')}</strong>
        <p className={settingsCss.muted}>{t('modelsFooterHint')}</p>
      </div>
      {openGateway && (
        <Button variant="outline" onClick={openGateway}>
          {t('openGateway')}
        </Button>
      )}
    </div>
  )
}

export function apply(ctx: Context, navigation: { openGateway?: () => void } = {}): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-opl-gateway: dictionaries')
  ctx.slots.inject('settings.models.footer', () =>
    ctx.slots.register(
      {
        name: 'settings.models.footer',
        id: 'opl-gateway-models-entry',
        locale: NS,
        inject: () => ({
          ...(navigation.openGateway ? { openGateway: navigation.openGateway } : {}),
        }),
      },
      OplGatewayModelsFooter,
    ),
  )
  ctx.inject(['remote.oplGatewayAccount'], (ctx) => {
    const call = remoteCall(ctx.remote.oplGatewayAccount)
    const injected = (): OplGatewaySectionInjected => {
      const models = optionalRemote(ctx, 'oplGatewayModels')
      const modelsCall = models ? remoteCall(models) : undefined
      return {
        ...(modelsCall
          ? {
              modelsCall,
              setGroupActive: (id: string, enabled: boolean) =>
                modelsCall('activate', { id, enabled }),
            }
          : {}),
        codexTargets: () => call('codexTargets'),
        configureCodex: (target, distro, install) =>
          call('configureCodex', target, distro, install),
        status: () => call('status'),
        signIn: (email, password, remember) => call('signIn', email, password, remember),
        rememberedLogin: () => call('rememberedLogin'),
        signInRemembered: (email) => call('signInRemembered', email),
        forgetPassword: () => call('forgetPassword'),
        refresh: () => call('refresh'),
        signOut: () => call('signOut'),
      }
    }
    ctx.slots.inject('settings.section', () =>
      ctx.slots.register(
        {
          name: 'settings.section',
          id: 'opl-gateway',
          order: SETTINGS_ORDER['opl-gateway'],
          label: () => ctx.locale.bind(NS)('nav'),
          locale: NS,
          inject: injected,
        },
        OplGatewaySection,
      ),
    )
  })
}
