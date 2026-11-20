import { useMemo, useSyncExternalStore } from 'react'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { FeatureSwitch } from '../../shared/client/FeaturePreferences.tsx'
import type { ExecutionCall } from '../../shared/client/remote-call.ts'
import { MiniMaxAccountSection } from './MiniMaxAccountSection.tsx'
import css from '../../shared/client/SettingsSection.module.css'

export interface MiniMaxIntegrationSettings {
  minimaxCodeEnabled: boolean
}

export type MiniMaxIntegrationForm = ConfigForm<MiniMaxIntegrationSettings>
export type MiniMaxIntegrationLocale = PropsLocale<'settings.minimaxAccount'>['t']
export interface MiniMaxIntegrationSeat {
  form: MiniMaxIntegrationForm
  t: MiniMaxIntegrationLocale
}

/** Subscribe every MiniMax surface to the same accepted Host configuration. */
export function useMiniMaxIntegrationSnapshot(
  form: MiniMaxIntegrationForm,
): ConfigFormSnapshot<MiniMaxIntegrationSettings> {
  const source = useMemo(
    () => ({
      subscribe: (listener: () => void) => form.subscribe(listener),
      getSnapshot: () => form.getSnapshot(),
    }),
    [form],
  )
  return useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
}

export function miniMaxIntegrationEnabled(
  snapshot: ConfigFormSnapshot<MiniMaxIntegrationSettings>,
): boolean {
  return snapshot.status === 'ready' && snapshot.value?.minimaxCodeEnabled === true
}

/** One preference row in the existing execution page; there is no second editable state. */
export function MiniMaxIntegrationPreference({
  form,
  t,
}: {
  form: MiniMaxIntegrationForm
  t: MiniMaxIntegrationLocale
}) {
  const snapshot = useMiniMaxIntegrationSnapshot(form)
  const stateNotice =
    snapshot.status === 'loading'
      ? t('integrationLoading')
      : snapshot.status === 'unavailable'
        ? t('integrationUnavailable')
        : !snapshot.writable
          ? t('integrationReadOnly')
          : ''
  return (
    <div data-opl-preference="minimax-integration">
      <FeatureSwitch
        form={form}
        field="minimaxCodeEnabled"
        title={t('integration')}
        description={t('integrationDescription')}
        saveFailed={t('integrationSaveFailed')}
        busyLabel={t('integrationSaving')}
      />
      {stateNotice && (
        <p role="status" className={css.muted}>
          {stateNotice}
        </p>
      )}
    </div>
  )
}

/** The model-provider footer follows the identical configForms snapshot as the switch. */
export function MiniMaxAccountGate({
  form,
  call,
  t,
}: {
  form: MiniMaxIntegrationForm
  call: ExecutionCall
  t: MiniMaxIntegrationLocale
}) {
  const snapshot = useMiniMaxIntegrationSnapshot(form)
  return miniMaxIntegrationEnabled(snapshot) ? <MiniMaxAccountSection call={call} t={t} /> : null
}
