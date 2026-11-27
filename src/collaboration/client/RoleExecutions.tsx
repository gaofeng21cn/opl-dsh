import { useEffect, useRef, useState } from 'react'
import type { RoleExecutionCall } from '../../shared/client/remote-call.ts'
import type { RoleExecutionCatalog } from '../contracts/roles.ts'
import css from '../../shared/client/SettingsSection.module.css'
import { defaultCollaborationT, type CollaborationT } from './collaboration-locales.ts'

export function RoleExecutions({
  call,
  t = defaultCollaborationT,
}: {
  call?: RoleExecutionCall
  t?: CollaborationT
}) {
  const [catalog, setCatalog] = useState<RoleExecutionCatalog>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const tRef = useRef(t)
  tRef.current = t
  useEffect(() => {
    let live = true
    if (call)
      void call('catalog')
        .then((value) => {
          if (live) setCatalog(value)
        })
        .catch((cause) => {
          if (live)
            setError(cause instanceof Error ? cause.message : tRef.current('roleReadFailed'))
        })
    return () => {
      live = false
    }
  }, [call])
  async function save(preset: string, combination: string) {
    if (!call || !catalog || busy) return
    const bindings = { ...catalog.bindings }
    if (combination) bindings[preset] = combination
    else delete bindings[preset]
    setBusy(true)
    setError('')
    try {
      setCatalog(await call('save', { bindings }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('roleSaveFailed'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className={css.detailsBody} data-opl-role-executions>
      <p className={css.muted}>{t('roleDescription')}</p>
      {!call && <p role="status">{t('roleEnableRequired')}</p>}
      {call && !catalog && !error && <p role="status">{t('roleLoading')}</p>}
      {catalog?.presets.map((preset) => {
        const selected = catalog.bindings[preset.id] ?? ''
        const missing = selected && !catalog.combinations.some((item) => item.id === selected)
        return (
          <label className={css.field} key={preset.id}>
            {preset.name}
            <select
              className={css.input}
              value={selected}
              disabled={busy || !!preset.broken}
              onChange={(event) => void save(preset.id, event.target.value)}
            >
              <option value="">{t('roleFollowSession')}</option>
              {missing && (
                <option value={selected} disabled>
                  {t('rolePreviousUnavailable')}
                </option>
              )}
              {catalog.combinations.map((item) => (
                <option key={item.id} value={item.id} disabled={!item.available}>
                  {item.name}
                  {item.available ? '' : t('roleUnavailableSuffix')}
                </option>
              ))}
            </select>
            {preset.broken && <span role="status">{preset.broken}</span>}
          </label>
        )
      })}
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
