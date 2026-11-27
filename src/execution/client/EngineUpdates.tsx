import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ExecutionCall } from '../../shared/client/remote-call.ts'
import type { EngineUpdateState } from '../contracts/engine-updates.ts'
import css from '../../shared/client/SettingsSection.module.css'
import choices from './RecommendationPicker.module.css'
import { defaultExecutionT, type ExecutionSettingsT } from './execution-settings-locales.ts'
import { safeFailureMessage } from './proxy-draft.ts'

export function EngineUpdates({
  call,
  detectButton,
  t = defaultExecutionT,
}: {
  call: ExecutionCall
  detectButton: ReactNode
  t?: ExecutionSettingsT
}) {
  const labels = {
    current: t('engineUpdateStatusCurrent'),
    unsupported: t('engineUpdateStatusUnsupported'),
    failed: t('engineUpdateStatusFailed'),
    installing: t('engineUpdateStatusInstalling'),
    waiting: t('engineUpdateStatusWaiting'),
    updated: t('engineUpdateStatusUpdated'),
    available: t('engineUpdateStatusAvailable'),
  }
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<EngineUpdateState>()
  const [skipped, setSkipped] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const revision = useRef(0)
  const pending = useRef(false)
  const tRef = useRef(t)
  tRef.current = t
  const active =
    state?.checking || state?.items.some((item) => ['installing', 'waiting'].includes(item.status))
  useEffect(() => {
    let mounted = true
    const read = async () => {
      if (pending.current) return
      const id = ++revision.current
      try {
        const s = await call('engine-updates')
        if (mounted && id === revision.current) {
          setState(s)
        }
      } catch (e) {
        if (mounted && id === revision.current)
          setError(safeFailureMessage(e, tRef.current('engineUpdatesReadFailed')))
      }
    }
    void read()
    const timer = setInterval(() => void read(), active ? 2000 : 30000)
    return () => {
      mounted = false
      clearInterval(timer)
    }
  }, [active, call])
  const run = async (fn: () => Promise<EngineUpdateState>) => {
    if (pending.current) return
    pending.current = true
    const id = ++revision.current
    setBusy(true)
    setError('')
    try {
      const s = await fn()
      if (id === revision.current) setState(s)
    } catch (e) {
      setError(safeFailureMessage(e, tRef.current('actionFailedRetry')))
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const batchIds = new Set(state?.selectedIds)
  const batch = state?.items.filter((item) => batchIds.has(item.id)) ?? []
  const finished = batch.filter((item) => item.status === 'updated' || item.status === 'failed')
  const available =
    state?.items.filter((item) => item.status === 'available' && !batchIds.has(item.id)) ?? []
  const selected = available.filter((item) => !skipped.includes(item.id)).map((item) => item.id)
  const others =
    state?.items.filter((item) => item.status !== 'available' && !batchIds.has(item.id)) ?? []
  return (
    <>
      <div className={`${css.actions} ${css.engineUpdateToolbar}`}>
        {detectButton}
        <Button
          id="opl-engine-updates-toggle"
          variant="outline"
          aria-expanded={open}
          aria-controls="opl-engine-updates"
          onClick={() => setOpen(!open)}
        >
          {t('engineUpdatesToggle')}
          {available.length > 0 && t('engineUpdatesCount', { count: available.length })}
        </Button>
      </div>
      {open && (
        <section
          id="opl-engine-updates"
          className={`${css.section} ${css.engineUpdatePanel}`}
          aria-label={t('engineUpdatesPanelLabel')}
        >
          <div className={css.preferenceRow}>
            <div className={css.preferenceText}>
              <span className={css.preferenceTitle}>{t('engineUpdatesAutoLabel')}</span>
            </div>
            <Switch
              label={t('engineUpdatesAutoLabel')}
              disabled={!state || busy}
              checked={state?.enabled ?? false}
              onChange={(enabled) => {
                if (state)
                  void run(() => call('engine-updates-settings', { enabled, mode: state.mode }))
              }}
            />
          </div>
          {state?.enabled && (
            <label className={css.field}>
              {t('engineUpdatesModeLabel')}
              <select
                className={css.input}
                disabled={busy}
                value={state.mode}
                onChange={(e) => {
                  const mode = e.currentTarget.value === 'auto' ? 'auto' : 'notify'
                  void run(() => call('engine-updates-settings', { enabled: true, mode }))
                }}
              >
                <option value="notify">{t('engineUpdatesModeNotify')}</option>
                <option value="auto">{t('engineUpdatesModeAuto')}</option>
              </select>
            </label>
          )}
          {state?.enabled && state.mode === 'auto' && (
            <p className={css.muted}>{t('engineUpdatesAutoHint')}</p>
          )}
          {available.length > 0 && (
            <div className={choices.updateList}>
              {available.map((item) => (
                <label className={choices.updateChoice} key={item.id}>
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={selected.includes(item.id)}
                    onChange={(e) =>
                      setSkipped(
                        e.currentTarget.checked
                          ? skipped.filter((id) => id !== item.id)
                          : [...skipped, item.id],
                      )
                    }
                  />
                  <span className={choices.itemText}>
                    <span>{item.name}</span>
                    <span className={css.muted}>
                      {item.current} → {item.target}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          )}
          <div className={`${css.actions} ${css.engineUpdateToolbar}`}>
            <Button
              variant="outline"
              disabled={busy || active}
              onClick={() => void run(() => call('engine-updates-check'))}
            >
              {state?.checking ? t('engineUpdatesChecking') : t('engineUpdatesCheck')}
            </Button>
            {available.length > 0 && (
              <Button
                disabled={busy || !selected.length || state?.checking}
                onClick={() => {
                  setSubmitting(true)
                  void run(() => call('engine-updates-install', { ids: selected })).finally(() =>
                    setSubmitting(false),
                  )
                }}
              >
                {submitting
                  ? t('engineUpdatesSubmitting')
                  : t('engineUpdatesInstallSelected', { count: selected.length })}
              </Button>
            )}
          </div>
          {batch.length > 0 && (
            <div aria-live="polite" className={css.engineBatch}>
              <p>
                {t('engineUpdatesBatchSummary', {
                  finished: finished.length,
                  total: batch.length,
                })}
              </p>
              {batch.map((item) => (
                <div key={item.id}>
                  <p className={css.row}>
                    <span>{item.name}</span>
                    <span className={item.status === 'failed' ? css.error : css.muted}>
                      {item.status === 'available'
                        ? t('engineUpdateStatusQueued')
                        : labels[item.status]}
                    </span>
                  </p>
                  {item.status === 'failed' && item.message && (
                    <p className={css.error}>{item.message}</p>
                  )}
                </div>
              ))}
            </div>
          )}
          {state?.checkedAt && (
            <p className={css.muted}>
              {t('engineUpdatesLastChecked', {
                time: new Date(state.checkedAt).toLocaleString(),
              })}
            </p>
          )}
          {others.length > 0 && (
            <details className={css.engineCheckResults}>
              <summary>{t('engineUpdatesOthersSummary', { count: others.length })}</summary>
              {others.map((item) => (
                <p key={item.id}>
                  {item.name} · {labels[item.status]}
                  {item.message && <span className={css.muted}> · {item.message}</span>}
                </p>
              ))}
            </details>
          )}
          {error && (
            <p className={css.error} role="alert">
              {error}
            </p>
          )}
        </section>
      )}
    </>
  )
}
