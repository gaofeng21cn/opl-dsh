/**
 * Composer entry of the context-budget view, mounted through the official
 * `conversation.input.left` list slot. The entry is a plain `<button>`
 * (`aria-expanded`, `aria-haspopup`, Escape closes) and reads are driven by the
 * official Session lifecycle and `modelSelection` signals plus panel opening —
 * never by a timer, a prompt, or a setting write.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ContextBudgetSnapshot } from '../contracts/budget.ts'
import { ContextBudgetPanel } from './ContextBudgetPanel.tsx'
import { ContextBudgetReadStore } from './controller.ts'
import type { BudgetPreference } from './preference.ts'
import css from './ContextBudgetPanel.module.css'

/** Props composed by the slot framework for this entry. */
export interface ContextBudgetControlProps extends PropsLocale<'conversation.oplContextBudget'> {
  /** Session this composer entry belongs to. */
  sessionId: string
  /** The single read dependency; injected from {@link Config} by the plugin. */
  read: (sessionId: string) => Promise<ContextBudgetSnapshot>
  /** Public Session lifecycle refresh signal; absence simply means no refresh trigger. */
  subscribeSession?: ((sessionId: string, listener: () => void) => () => void) | undefined
  /** Connected-Host generation signal; absence simply means no reconnect invalidation. */
  subscribeConnection?: ((listener: () => void) => () => void) | undefined
}

/** @param props - Composer dependencies and local preference. @returns An entry only when enabled. */
export function OptionalBudgetControl({
  preference,
  ...props
}: ContextBudgetControlProps & { preference: BudgetPreference }) {
  const state = useSyncExternalStore(preference.state.subscribe, preference.state.getSnapshot)
  return state.enabled ? <ContextBudgetControl {...props} /> : null
}

/**
 * Render the compact entry and its expandable panel.
 * @param props - Session identity, read dependency, refresh signals, locale seat.
 * @returns the composer control.
 */
export function ContextBudgetControl({
  sessionId,
  read,
  subscribeSession,
  subscribeConnection,
  t,
}: ContextBudgetControlProps) {
  // Injected props may be replaced between renders; the store always calls the
  // current read so a swapped seam cannot leave the entry bound to a stale one.
  const latest = useRef({ read })
  latest.current = { read }
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const store = useMemo(
    () => new ContextBudgetReadStore({ read: (id) => latest.current.read(id) }),
    [],
  )
  // Bind during render: a re-render that switches Session must already have
  // stopped accepting the previous Session's answer.
  store.target(sessionId)
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  // Unmount silences the store before any other cleanup runs.
  useEffect(() => () => store.detach(), [store])
  useEffect(() => {
    void store.load(sessionId)
    const off = subscribeSession?.(sessionId, () => void store.load(sessionId))
    return () => off?.()
  }, [store, sessionId, subscribeSession])
  useEffect(() => {
    if (!subscribeConnection) return
    return subscribeConnection(() => {
      // A new Host generation invalidates everything read from the old one.
      store.reset()
      void store.load(sessionId)
    })
  }, [store, sessionId, subscribeConnection])
  // Opening the panel re-reads: pressure accumulated by a running turn moves
  // without any lifecycle or selection signal, and this is the user's own
  // action rather than a timer. A Session switch while open is already covered
  // by the session effect above, so only the closed→open edge reads here.
  const wasOpen = useRef(false)
  useEffect(() => {
    const opened = open && !wasOpen.current
    wasOpen.current = open
    if (opened) void store.load(sessionId)
  }, [open, store, sessionId])
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [open])
  return (
    <div ref={root} className={css.root} data-opl-context-budget="">
      <button
        type="button"
        className={css.trigger}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={t('entryAria')}
        onClick={() => setOpen((value) => !value)}
      >
        {t('entry')}
      </button>
      {open ? (
        <ContextBudgetPanel view={view} onRead={() => void store.load(sessionId)} t={t} />
      ) : null}
    </div>
  )
}
