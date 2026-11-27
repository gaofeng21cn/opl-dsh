import { useEffect, useState, useRef } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CoordinationCall } from '../../shared/client/remote-call.ts'
import type { CoordinatorHooksStatus } from '../../contracts/types.ts'
import css from '../../shared/client/SettingsSection.module.css'
import { defaultCollaborationT, type CollaborationT } from './collaboration-locales.ts'

export function useCoordinatorHooks(
  call: CoordinationCall,
  t: CollaborationT = defaultCollaborationT,
) {
  const [status, setStatus] = useState<CoordinatorHooksStatus>()
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const active = useRef(false),
    generation = useRef(0),
    tRef = useRef(t)
  tRef.current = t
  async function run(action: 'status' | 'install' | 'remove') {
    if (active.current) return
    active.current = true
    const id = ++generation.current
    setBusy(true)
    setError('')
    try {
      const s = await call('coordinator-hooks', action)
      if (id === generation.current) setStatus(s)
    } catch (e) {
      if (id === generation.current)
        setError(e instanceof Error ? e.message : tRef.current('hookReadFailed'))
    } finally {
      if (id === generation.current) {
        active.current = false
        setBusy(false)
      }
    }
  }
  useEffect(() => {
    const refresh = () => {
      void run('status')
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      generation.current++
      active.current = false
    }
  }, [call])
  const summary = error
    ? t('hookSummaryUnknown')
    : !status
      ? t('hookSummaryChecking')
      : !status.installed
        ? t('hookSummaryMissing')
        : status.registered !== status.total
          ? t('hookSummaryCheckConfig')
          : status.verified !== status.total
            ? t('hookSummaryTrustUnknown')
            : status.disabled
              ? t('hookSummaryDisabled', { count: status.disabled })
              : t('hookSummaryTrusted', { trusted: status.trusted, total: status.total })
  return { status, error, busy, run, summary }
}

export function CoordinatorHooks({
  status: s,
  error,
  busy,
  run,
  t = defaultCollaborationT,
}: ReturnType<typeof useCoordinatorHooks> & { t?: CollaborationT }) {
  const hint =
    !error &&
    s?.installed &&
    s.registered === s.total &&
    s.verified === s.total &&
    s.trusted < s.total
      ? t('hookPendingConfirmHint', { remaining: s.total - s.trusted })
      : undefined
  return (
    <div className={css.detailsBody}>
      <p className={css.muted}>{t('hooksIntro')}</p>
      {hint && <p role="status">{hint}</p>}
      {error && <p role="alert">{error}</p>}
      <div className={css.actions}>
        <Button
          variant="outline"
          disabled={busy || !s}
          onClick={() => void run(s?.installed ? 'remove' : 'install')}
        >
          {s?.installed ? t('hooksRemove') : t('hooksInstall')}
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => void run('status')}>
          {t('hooksRefresh')}
        </Button>
      </div>
    </div>
  )
}
