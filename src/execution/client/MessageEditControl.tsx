/** Exceptional edit controls; the message action owns normal selection. */
import { useEffect, useSyncExternalStore } from 'react'
import { IconCloseOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { messageEditCopy, type MessageEditSession } from './message-edit-session.ts'
import css from './StopEditControl.module.css'

export interface MessageEditProps {
  session: MessageEditSession
  inputActions: { setDraft(text: string): void }
  subscribeSession?: (id: string, listener: () => void) => () => void
  locked?: boolean
  onActiveChange?: (active: boolean) => void
}

/**
 * The normal entry sits on each user message. This composer seat retains only
 * actions that need a wider explanation: unconfirmed recovery and failures.
 */
export function MessageEditControl({
  session,
  inputActions,
  subscribeSession,
  locked = false,
  onActiveChange,
}: MessageEditProps) {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
  const selection = snapshot.selection
  const recovery = snapshot.state?.recovery
  const visible = selection !== undefined || recovery !== undefined || snapshot.error !== undefined

  useEffect(() => {
    void session.load()
    const off = subscribeSession?.(session.sessionId, () => void session.load())
    return () => off?.()
  }, [session, subscribeSession])

  useEffect(() => {
    onActiveChange?.(visible)
    return () => onActiveChange?.(false)
  }, [visible, onActiveChange])

  if (!visible) return null
  return (
    <div className={css.root} data-opl-message-edit-state="">
      {recovery ? (
        <button
          type="button"
          className={css.trigger}
          disabled={locked || snapshot.state?.busy}
          onClick={() => void session.recover()}
        >
          {messageEditCopy.recover}
        </button>
      ) : null}
      {selection ? (
        <Tooltip label={messageEditCopy.cancel} side="top">
          <button
            type="button"
            className={css.iconTrigger}
            aria-label={messageEditCopy.cancel}
            disabled={locked || snapshot.state?.busy || snapshot.state?.pending}
            onClick={() => {
              const previous = session.cancel()
              if (previous) inputActions.setDraft(previous.previousDraft)
            }}
          >
            <IconCloseOutlineRegular />
          </button>
        </Tooltip>
      ) : null}
      {snapshot.error ? (
        <button
          type="button"
          className={css.status}
          title="关闭提示"
          onClick={() => session.dismissError()}
        >
          {snapshot.error}
        </button>
      ) : null}
    </div>
  )
}
