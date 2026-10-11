import { useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { HuaweiMaaSKeyResult, HuaweiMaaSStatus } from '../contracts/huawei-maas.ts'
import css from '../../shared/client/SettingsSection.module.css'

/** Local credential edits use write-only methods; status never returns a key. */
export interface HuaweiMaaSSectionInjected {
  readStatus: () => Promise<HuaweiMaaSStatus>
  saveKey: (key: string) => Promise<HuaweiMaaSKeyResult>
  clearKey: () => Promise<HuaweiMaaSKeyResult>
}

/** Configure the Huawei credential without restoring its value into the input. */
export function HuaweiMaaSSection({
  t,
  readStatus,
  saveKey,
  clearKey,
}: PropsLocale<'settings.oplHuaweiMaas'> & HuaweiMaaSSectionInjected) {
  const [status, setStatus] = useState<HuaweiMaaSStatus>()
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(true)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const mounted = useRef(false)
  const pending = useRef(false)

  useEffect(() => {
    mounted.current = true
    void readStatus()
      .then((value) => {
        if (mounted.current) setStatus(value)
      })
      .catch(() => {
        if (mounted.current) setError(t('failure'))
      })
      .finally(() => {
        if (mounted.current) setBusy(false)
      })
    return () => {
      mounted.current = false
    }
  }, [readStatus, t])

  const act = async (operation: 'save' | 'clear' | 'refresh'): Promise<void> => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setNotice('')
    setError('')
    const submitted = key
    if (operation === 'save') setKey('')
    try {
      if (operation === 'refresh') {
        const value = await readStatus()
        if (mounted.current) setStatus(value)
        return
      }
      const result = operation === 'save' ? await saveKey(submitted) : await clearKey()
      if (!mounted.current) return
      setStatus(result.status)
      if (result.ok) setNotice(t(operation === 'save' ? 'saved' : 'cleared'))
      else
        setError(
          t(
            result.failure === 'empty-value' ||
              result.failure === 'invalid-value' ||
              result.failure === 'value-too-large'
              ? 'invalid'
              : 'failure',
          ),
        )
    } catch {
      if (mounted.current) setError(t('failure'))
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }

  return (
    <section className={css.section} data-opl-panel="huawei-maas" aria-busy={busy}>
      <header className={css.header}>
        <div>
          <h2 className={css.title}>{t('nav')}</h2>
          <p className={css.intro}>{t('intro')}</p>
        </div>
        <Button variant="outline" disabled={busy} onClick={() => void act('refresh')}>
          {t('refresh')}
        </Button>
      </header>
      {error && (
        <p className={`${css.notice} ${css.error}`} role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className={css.notice} role="status">
          {notice}
        </p>
      )}
      {!status ? (
        <p className={css.muted}>{t('loading')}</p>
      ) : (
        <>
          <dl className={css.facts}>
            <dt className={css.factLabel}>{t('endpoint')}</dt>
            <dd className={css.factValue}>{status.baseUrl}</dd>
            <dt className={css.factLabel}>{t('model')}</dt>
            <dd className={css.factValue}>{status.model}</dd>
          </dl>
          <p role="status">
            {t(
              !status.credential.supported
                ? 'unsupported'
                : !status.credential.available
                  ? 'unavailable'
                  : status.credential.configured
                    ? 'stored'
                    : 'missing',
            )}
          </p>
          <p className={css.muted}>{t('storage')}</p>
          <form
            className={css.form}
            onSubmit={(event) => {
              event.preventDefault()
              void act('save')
            }}
          >
            <label className={css.field}>
              <span className={css.label}>{t('key')}</span>
              <input
                className={css.input}
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={t('placeholder')}
                value={key}
                disabled={busy || !status.credential.available}
                onChange={(event) => setKey(event.target.value)}
              />
            </label>
            <Button
              variant="primary"
              type="submit"
              disabled={busy || !status.credential.available || !key.trim()}
            >
              {t('save')}
            </Button>
            <Button
              variant="outline"
              disabled={busy || !status.credential.available || !status.credential.configured}
              onClick={() => void act('clear')}
            >
              {t('clear')}
            </Button>
          </form>
        </>
      )}
    </section>
  )
}
