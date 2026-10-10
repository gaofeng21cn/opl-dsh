/** System notification preferences in the official settings shell. */
import { useState, useSyncExternalStore } from 'react'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { TaskNotificationController } from './controller.ts'
import css from '../../shared/client/SettingsSection.module.css'

/** @param props - Locale and the mounted notification controller. @returns Notification settings. */
export function NotificationSection({
  t,
  controller,
}: PropsLocale<'settings.oplNotifications'> & { controller: TaskNotificationController }) {
  const state = useSyncExternalStore(controller.state.subscribe, controller.state.getSnapshot)
  const [busy, setBusy] = useState(false)
  const test = async () => {
    setBusy(true)
    try {
      await controller.test()
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className={css.section} data-opl-panel="notifications">
      <h2 className={css.title}>{t('nav')}</h2>
      <p className={css.intro}>{t('intro')}</p>
      <div className={css.card}>
        <div className={css.row}>
          <span>{t('enabled')}</span>
          <Switch
            label={t('enabled')}
            checked={state.enabled}
            onChange={(value) => controller.setEnabled(value)}
          />
        </div>
        <p className={css.muted}>{t('help')}</p>
        <p className={css.muted}>{t('privacy')}</p>
        <Button
          variant="outline"
          disabled={busy || state.status === 'unsupported'}
          onClick={() => void test()}
        >
          {t(busy ? 'sending' : 'test')}
        </Button>
        <p
          role="status"
          className={
            state.status === 'failure' || state.status === 'denied' ? css.error : css.notice
          }
        >
          {t(state.status)}
        </p>
        {state.savingFailed && (
          <p role="alert" className={css.error}>
            {t('savingFailure')}
          </p>
        )}
      </div>
    </section>
  )
}
