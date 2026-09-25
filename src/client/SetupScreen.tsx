/** One app-owned first-run dialog; provider services retain authentication and model selection. */
import { useEffect, useState } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { OplGatewaySection, type OplGatewaySectionProps } from './gateway/OplGatewaySection.tsx'
import type { SetupStatus } from '../setup-types.ts'
import type { LoginChoice } from '../setup-config.ts'
import css from './gateway/OplGatewaySection.module.css'

type Choice = Exclude<LoginChoice, 'undecided'>
export interface SetupActions {
  readSetup: () => Promise<SetupStatus>
  finish: (choice: Choice) => Promise<void>
  startOfficial: () => Promise<void>
  cancelOfficial: () => Promise<void>
  saveOfficialKey: (key: string) => Promise<void>
}
export function SetupScreen(props: OplGatewaySectionProps & SetupActions) {
  const { t } = props
  const [page, setPage] = useState<'entry' | 'gateway' | 'official' | 'key' | 'waiting'>('entry')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [key, setKey] = useState('')
  const [phase, setPhase] = useState('')
  useEffect(() => {
    let active = true
    void props.readSetup().then(async status => {
      if (status.completed) return
      // Upgrade an already configured installation without interrupting its user.
      if (status.gatewayReady || status.officialProvider || status.choice === 'later') {
        await props.finish(status.choice === 'later' ? 'later' : status.choice === 'official' && status.officialProvider ? 'official' : status.gatewayReady ? 'gateway' : 'official')
      } else if (active) setOpen(true)
    }).catch(() => { if (active) { setOpen(true); setError(t('setupFailed')) } })
    return () => { active = false }
  }, [props.readSetup, props.finish, t])
  const run = async (operation: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setError('')
    try { await operation() } catch { setError(t('setupFailed')) } finally { setBusy(false) }
  }
  const finish = async (choice: Choice) => { await props.finish(choice); setOpen(false) }
  useEffect(() => {
    if (page !== 'waiting') return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const status = await props.readSetup()
        if (!active) return
        if (status.officialProvider) { await props.finish('official'); if (active) setOpen(false); return }
        setPhase(status.officialPhase ?? '')
        timer = setTimeout(() => { void poll() }, 1000)
      } catch { if (active) { setError(t('setupFailed')); setPage('official') } }
    }
    void poll()
    return () => { active = false; clearTimeout(timer) }
  }, [page, props.readSetup, props.finish, t])
  const back = () => { void run(async () => { if (page === 'waiting') await props.cancelOfficial(); setKey(''); setPage('entry') }) }
  return <Modal open={open} headless title={t('setupTitle')} onClose={() => {}} className={css.setup}>
    <div className={css.brand}><span className={css.brandMark} aria-hidden>O</span><span>OPL <span className={css.brandLight}>DSH</span></span></div>
    {page === 'entry' ? <>
      <div className={css.welcomeHeading}><h1>{t('setupTitle')}</h1><p>{t('setupIntro')}</p></div>
      <div className={css.choices}>
        <button className={`${css.choice} ${css.recommended}`} data-modal-autofocus disabled={busy} onClick={() => setPage('gateway')}><span className={css.choiceTop}><strong>{t('setupGateway')}</strong><span aria-hidden>↗</span></span><span>{t('setupGatewayHint')}</span></button>
        <button className={css.choice} disabled={busy} onClick={() => setPage('official')}><span className={css.choiceTop}><strong>{t('setupOfficial')}</strong><span aria-hidden>→</span></span><span>{t('setupOfficialHint')}</span></button>
      </div>
      <button className={css.textButton} disabled={busy} onClick={() => { void run(() => finish('later')) }}>{t('setupLater')}</button>
    </> : <>
      {page === 'gateway' ? <OplGatewaySection {...props} onboarding onBusyChange={setBusy} onReady={() => finish('gateway')} /> : <>
        <div className={css.welcomeHeading}><h1>{t(page === 'key' ? 'officialKeyTitle' : page === 'waiting' ? 'officialWaiting' : 'setupOfficial')}</h1><p>{t(page === 'key' ? 'officialKeyHint' : page === 'waiting' ? 'officialWaitingHint' : 'setupOfficialHint')}</p></div>
        {page === 'key' ? <form className={css.form} onSubmit={event => { event.preventDefault(); void run(async () => { await props.saveOfficialKey(key); setKey(''); setOpen(false) }) }}>
          <label className={css.field}><span className={css.label}>API Key</span><input className={css.input} type='password' autoComplete='off' data-modal-autofocus required value={key} onChange={event => setKey(event.target.value)} placeholder='sk-…' disabled={busy} /></label>
          <button className={css.primaryButton} disabled={busy || !key.trim()}>{t(busy ? 'setupSaving' : 'saveAndEnter')}</button>
        </form> : <div className={css.loginActions}>
          <button className={css.primaryButton} disabled={busy || (page === 'waiting' && !['failed','expired','cancelled'].includes(phase))} onClick={() => { void run(async () => { await props.startOfficial(); setPhase(''); setPage('waiting') }) }}>{t(page === 'waiting' ? ['failed','expired','cancelled'].includes(phase) ? 'officialRetry' : 'officialWaiting' : 'officialSignIn')}</button>
          <button className={css.secondaryButton} disabled={busy} onClick={() => { void run(async () => { if (page === 'waiting') await props.cancelOfficial(); setPage('key') }) }}>{t('officialUseKey')}</button>
        </div>}
      </>}
      <button className={css.textButton} disabled={busy} onClick={back}>{t('setupBack')}</button>
    </>}
    {error && <p role='alert' className={`${css.notice} ${css.error}`}>{error}</p>}
    <p className={css.setupFootnote}>{t('setupFootnote')}</p>
  </Modal>
}
