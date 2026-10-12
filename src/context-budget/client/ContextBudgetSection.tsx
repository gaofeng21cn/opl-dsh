/** Local context-budget display settings. */
import { useSyncExternalStore } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { BudgetPreference } from './preference.ts'
import css from '../../shared/client/SettingsSection.module.css'

/** @param props - Locale and shared display preference. @returns The settings section. */
export function ContextBudgetSection({
  t,
  preference,
}: PropsLocale<'conversation.oplContextBudget'> & { preference: BudgetPreference }) {
  const state = useSyncExternalStore(preference.state.subscribe, preference.state.getSnapshot)
  return (
    <section className={css.section} data-opl-panel="context-budget">
      <div className={css.row}>
        <h3 className={css.name}>{t('panelTitle')}</h3>
        <Switch
          label={t('enabled')}
          checked={state.enabled}
          onChange={(value) => preference.setEnabled(value)}
        />
      </div>
      <p className={css.muted}>{t('settingsIntro')}</p>
      <p className={css.muted}>{t('settingsHelp')}</p>
      {state.savingFailed ? (
        <p role="alert" className={css.error}>
          {t('savingFailure')}
        </p>
      ) : null}
    </section>
  )
}
