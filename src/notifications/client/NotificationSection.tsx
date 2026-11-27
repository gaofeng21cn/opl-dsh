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
    <section className={css.officialRow} data-opl-panel="notifications">
      <div className={css.preferenceContent}>
        <div className={css.preferenceText}>
          <h3 className={css.preferenceTitle}>{t('nav')}</h3>
          <p className={css.preferenceDescription}>{t('intro')}</p>
          <p className={css.preferenceDescription}>
            {t('help')} {t('privacy')}
          </p>
        </div>
        <Switch
          label={t('enabled')}
          checked={state.enabled}
          onChange={(value) => controller.setEnabled(value)}
        />
      </div>
      <div className={css.notificationFooter}>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || state.status === 'unsupported'}
          onClick={() => void test()}
        >
          {t(busy ? 'sending' : 'test')}
        </Button>
        <span
          role="status"
          className={
            state.status === 'failure' || state.status === 'denied' ? css.error : css.muted
          }
        >
          {t(state.status)}
        </span>
      </div>
      {state.savingFailed && (
        <p role="alert" className={css.error}>
          {t('savingFailure')}
        </p>
      )}
    </section>
  )
}
