/** Account choice for the installer; the native official sign-in remains intact. */
import { useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { OplGatewaySection, type OplGatewaySectionProps } from './gateway/OplGatewaySection.tsx'
import type { LoginChoice } from '../setup-config.ts'
import css from './gateway/OplGatewaySection.module.css'

export function SetupScreen(props: OplGatewaySectionProps & { choose: (choice: LoginChoice) => Promise<boolean> }) {
  const [choice, setChoice] = useState<LoginChoice>('undecided')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const select = async (next: LoginChoice) => {
    setBusy(true); setError(false)
    try { if (!await props.choose(next)) throw new Error('choice refused'); setChoice(next) }
    catch { setError(true) }
    finally { setBusy(false) }
  }
  return <Modal open headless title={props.t('setupTitle')} onClose={() => { if (choice !== 'undecided') void select('undecided') }} className={css.setup}>
    {choice === 'undecided' ? <>
      <h1 className={css.title}>{props.t('setupTitle')}</h1>
      <p className={css.intro}>{props.t('setupIntro')}</p>
      <div className={css.choices}>
        <button className={css.choice} disabled={busy} onClick={() => { void select('gateway') }}><strong>{props.t('setupGateway')}</strong><span>{props.t('setupGatewayHint')}</span></button>
        <button className={css.choice} disabled={busy} onClick={() => { void select('official') }}><strong>{props.t('setupOfficial')}</strong><span>{props.t('setupOfficialHint')}</span></button>
      </div>
      <Button variant='outline' disabled={busy} onClick={() => { void select('later') }}>{props.t('setupLater')}</Button>
    </> : <>
      {choice === 'gateway' ? <OplGatewaySection {...props} /> : <><h1 className={css.title}>{props.t(choice === 'later' ? 'setupLater' : 'setupOfficial')}</h1><p className={css.intro}>{props.t(choice === 'later' ? 'setupLaterHint' : 'setupOfficialContinue')}</p></>}
      <div className={css.actions}><Button variant='outline' disabled={busy} onClick={() => { void select('undecided') }}>{props.t('setupBack')}</Button></div>
    </>}
    {busy && <p role='status'>{props.t('setupSaving')}</p>}
    {error && <p role='alert' className={css.error}>{props.t('setupFailed')}</p>}
  </Modal>
}
