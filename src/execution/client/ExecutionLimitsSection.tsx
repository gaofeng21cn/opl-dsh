import { useEffect, useRef, useState } from 'react'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import css from '../../shared/client/SettingsSection.module.css'
import type { ExecutionCall as Call } from '../../shared/client/remote-call.ts'
import { defaultExecutionT, type ExecutionSettingsT } from './execution-settings-locales.ts'

type Limits = { enabled: boolean; firstProgressMs: number; idleProgressMs: number }
const defaults: Limits = { enabled: false, firstProgressMs: 90_000, idleProgressMs: 90_000 }
const seconds = (value: number) => String(Math.max(1, Math.round(value / 1000)))

/** Persisted execution wait controls for turns started after saving. */
export function ExecutionLimitsSection({
  call,
  t = defaultExecutionT,
}: {
  call: Call
  t?: ExecutionSettingsT
}) {
  const [draft, setDraft] = useState<Limits>(defaults)
  const [busy, setBusy] = useState(true)
  const [message, setMessage] = useState('')
  const tRef = useRef(t)
  tRef.current = t
  useEffect(() => {
    let alive = true
    void call('execution-limits')
      .then((value) => {
        if (alive) {
          setDraft(value)
          setBusy(false)
        }
      })
      .catch(() => {
        if (alive) {
          setMessage(tRef.current('limitsReadFailed'))
          setBusy(false)
        }
      })
    return () => {
      alive = false
    }
  }, [call])
  const update = (key: 'firstProgressMs' | 'idleProgressMs', value: string, unit: number) => {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && Number.isInteger(parsed) && parsed >= 1)
      setDraft((current) => ({ ...current, [key]: parsed * unit }))
  }
  const save = async () => {
    setBusy(true)
    setMessage('')
    try {
      setDraft(await call('save-execution-limits', draft))
      setMessage(t('limitsSavedNotice'))
    } catch {
      setMessage(t('limitsSaveFailed'))
    } finally {
      setBusy(false)
    }
  }
  const reset = () => setDraft(defaults)
  return (
    <details className={css.details} data-opl-panel="execution-limits">
      <summary>{t('limitsSummary')}</summary>
      <div className={css.detailsBody}>
        <p className={css.muted}>{t('limitsIntro')}</p>
        <div className={css.preferenceRow}>
          <div className={css.preferenceText}>
            <div className={css.preferenceTitle}>{t('limitsEnableLabel')}</div>
          </div>
          <Switch
            label={t('limitsEnableLabel')}
            checked={draft.enabled}
            disabled={busy}
            onChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
          />
        </div>
        <label className={css.field}>
          {t('limitsFirstProgressLabel')}
          <input
            className={css.input}
            type="number"
            min="1"
            value={seconds(draft.firstProgressMs)}
            disabled={busy}
            onChange={(e) => update('firstProgressMs', e.target.value, 1000)}
          />
        </label>
        <label className={css.field}>
          {t('limitsIdleProgressLabel')}
          <input
            className={css.input}
            type="number"
            min="1"
            value={seconds(draft.idleProgressMs)}
            disabled={busy}
            onChange={(e) => update('idleProgressMs', e.target.value, 1000)}
          />
        </label>
        {message && (
          <p className={css.muted} role="status">
            {message}
          </p>
        )}
        <div className={css.actions}>
          <Button disabled={busy} onClick={() => void save()}>
            {t('limitsSaveButton')}
          </Button>
          <Button variant="outline" disabled={busy} onClick={reset}>
            {t('limitsResetButton')}
          </Button>
        </div>
      </div>
    </details>
  )
}
