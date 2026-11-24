/** Host-backed count selector placed beside the native performance preference. */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { IconChevronDownOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import css from './PreferenceRow.module.css'
import settingsCss from '../../shared/client/SettingsSection.module.css'

export type StatisticsMode = 'current' | 'history'
/** The count preference is one field of the existing Suite settings namespace. */
export interface StatisticsSettings {
  conversationStats: StatisticsMode
  /** Legacy opt-in marker, read only to migrate the former master switch. */
  enhancedConversationStats?: boolean
}

export interface StatisticsPreferenceLabels {
  title: string
  description: string
  current: string
  history: string
  help: string
  saveFailed: string
}

/** @param props - Official shared settings form and localized labels. @returns One general settings row. */
export function StatisticsPreferenceRow({
  form,
  labels,
}: {
  form: ConfigForm<StatisticsSettings>
  labels: StatisticsPreferenceLabels
}) {
  const source = useMemo(
    () => ({
      subscribe: (listener: () => void) => form.subscribe(listener),
      getSnapshot: () => form.getSnapshot(),
    }),
    [form],
  )
  const state = useSyncExternalStore(source.subscribe, source.getSnapshot)
  const mode = state.value?.conversationStats ?? 'history'
  const migratedLegacySetting = useRef(false)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const live = useRef(false)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  useEffect(() => {
    if (migratedLegacySetting.current || state.status !== 'ready' || !state.writable) return
    const user = state.user
    if (!user || typeof user !== 'object' || !('enhancedConversationStats' in user)) return
    migratedLegacySetting.current = true
    const clearLegacy = { op: 'unset' as const, path: ['enhancedConversationStats'] }
    const ops =
      user.enhancedConversationStats === false && state.value?.conversationStats === 'current'
        ? [{ op: 'set' as const, path: ['conversationStats'], value: 'history' }, clearLegacy]
        : [clearLegacy]
    void form.mutate(ops, state.revision).catch(() => {})
  }, [form, state])
  const select = async (value: string) => {
    if ((value !== 'current' && value !== 'history') || busy) return
    button.current?.focus({ preventScroll: true })
    setOpen(false)
    if (value === mode) return
    setBusy(true)
    setFailed(false)
    try {
      const accepted = await form.set('conversationStats', value)
      if (live.current) setFailed(!accepted)
    } catch (_error) {
      // ConfigForms owns the recovery read; show no success for a failed transport.
      if (live.current) setFailed(true)
    } finally {
      if (live.current) setBusy(false)
    }
  }
  return (
    <div className={settingsCss.preferenceRow} data-opl-preference="conversation-counts">
      <div className={settingsCss.preferenceText} title={labels.help}>
        <div className={settingsCss.preferenceTitle}>{labels.title}</div>
        <div className={settingsCss.preferenceDescription}>{labels.description}</div>
        {failed && (
          <div role="alert" className={css.error}>
            {labels.saveFailed}
          </div>
        )}
      </div>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        align="end"
        portal
        selectedId={mode}
        items={(
          [
            ['current', labels.current],
            ['history', labels.history],
          ] as const
        ).map(([id, label]) => ({ id, label }))}
        onSelect={(value) => void select(value)}
        anchor={
          <button
            ref={button}
            type="button"
            className={css.selector}
            aria-label={labels.title}
            aria-haspopup="menu"
            aria-expanded={open}
            disabled={busy || state.status !== 'ready' || !state.writable}
            onClick={() => setOpen((value) => !value)}
          >
            {mode === 'current' ? labels.current : labels.history}
            <IconChevronDownOutlineRegular className={css.chevron} />
          </button>
        }
      />
    </div>
  )
}
