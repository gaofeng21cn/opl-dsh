/** Same-session message selection; the official composer remains the send owner. */
import { useEffect, useRef, useState } from 'react'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ExecutionCall } from '../../shared/client/remote-call.ts'
import type { MessageEditState } from '../contracts/message-edit.ts'
import css from './StopEditControl.module.css'

export interface EditSelection {
  seq: number
  head: number
  previousDraft: string
}
const copy = {
  edit: '编辑消息',
  editing: '正在编辑消息',
  cancel: '取消编辑',
  conflict: '输入框已有草稿，请先发送或清空',
  failed: '无法读取可编辑消息，请重试',
  storage: '无法保存编辑状态，请重试',
  stop: '请先停止当前对话',
  recover: '重试未确认的编辑',
}
const keyFor = (sessionId: string) => `opl-message-edit-v1:${sessionId}`
function restored(sessionId: string): EditSelection | undefined {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(keyFor(sessionId)) ?? 'null')
    if (
      !value ||
      typeof value !== 'object' ||
      !('seq' in value) ||
      !('head' in value) ||
      !('previousDraft' in value)
    )
      return
    if (
      typeof value.seq === 'number' &&
      Number.isSafeInteger(value.seq) &&
      value.seq >= 0 &&
      typeof value.head === 'number' &&
      Number.isSafeInteger(value.head) &&
      value.head >= value.seq &&
      typeof value.previousDraft === 'string'
    )
      return { seq: value.seq, head: value.head, previousDraft: value.previousDraft }
  } catch {
    /* A damaged local selection cannot acquire edit ownership. */
  }
  return
}
export interface MessageEditProps {
  sessionId: string
  call: ExecutionCall
  inputActions: { setDraft(text: string): void }
  useInput: SnapshotSelectorHook<InputState>
  subscribeSession?: (id: string, listener: () => void) => () => void
  bindPrompt(
    id: string,
    selection: () => EditSelection | undefined,
    accepted: () => void,
  ): () => void
  locked?: boolean
  onActiveChange?: (active: boolean) => void
}

/** Editing selection is scoped to this Session and survives a local reload with its draft. */
export function MessageEditControl({
  sessionId,
  call,
  inputActions,
  useInput,
  subscribeSession,
  bindPrompt,
  locked = false,
  onActiveChange,
}: MessageEditProps) {
  const [state, setState] = useState<MessageEditState>()
  const [selection, setSelection] = useState<EditSelection>()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const selected = useRef<EditSelection>()
  const draft = useInput((input) => input.draft) ?? ''
  selected.current = selection
  useEffect(() => {
    let live = true
    let generation = 0
    const initial = restored(sessionId)
    selected.current = initial
    setSelection(initial)
    setOpen(false)
    setError('')
    setState(undefined)
    const clear = () => {
      if (!live) return
      selected.current = undefined
      setSelection(undefined)
      setOpen(false)
      try {
        localStorage.removeItem(keyFor(sessionId))
      } catch {
        setError(copy.storage)
      }
    }
    const load = async () => {
      const current = ++generation
      try {
        const value = await call('message-edit-state', { sessionId })
        if (!live || generation !== current) return
        setState(value)
        if (
          selected.current &&
          !value.pending &&
          !value.choices.some((choice) => choice.seq === selected.current!.seq)
        )
          clear()
      } catch {
        if (live && generation === current) setError(copy.failed)
      }
    }
    const offPrompt = bindPrompt(sessionId, () => selected.current, clear)
    const off = subscribeSession?.(sessionId, () => void load())
    void load()
    return () => {
      live = false
      generation++
      offPrompt()
      off?.()
    }
  }, [sessionId, call, bindPrompt, subscribeSession])
  useEffect(() => {
    onActiveChange?.(open)
    return () => onActiveChange?.(false)
  }, [open, onActiveChange])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('keydown', escape, true)
    }
  }, [open])
  if (!selection && !state?.recovery && (!state?.supported || !state.choices.length)) return null
  return (
    <div className={css.root} ref={root}>
      <button
        type="button"
        className={css.trigger}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {selection ? copy.editing : copy.edit}
      </button>
      {open && (
        <div className={css.panel}>
          {state?.recovery && (
            <button
              type="button"
              className={css.row}
              disabled={locked || state.busy}
              onClick={async () => {
                try {
                  await call('message-edit-send', state.recovery!)
                  setOpen(false)
                  setError('')
                } catch {
                  setError(copy.failed)
                }
              }}
            >
              {copy.recover}
            </button>
          )}
          {selection ? (
            <button
              type="button"
              className={css.row}
              disabled={locked || state?.busy || state?.pending}
              onClick={() => {
                try {
                  localStorage.removeItem(keyFor(sessionId))
                } catch {
                  setError(copy.storage)
                  return
                }
                selected.current = undefined
                setSelection(undefined)
                setOpen(false)
                inputActions.setDraft(selection.previousDraft)
              }}
            >
              {copy.cancel}
            </button>
          ) : (
            state?.choices.map((choice) => (
              <button
                type="button"
                className={css.row}
                key={choice.seq}
                disabled={locked || state.busy || state.pending}
                title={state.busy ? copy.stop : undefined}
                onClick={() => {
                  if (draft) {
                    setError(copy.conflict)
                    return
                  }
                  const value = { seq: choice.seq, head: state.head, previousDraft: draft }
                  try {
                    localStorage.setItem(keyFor(sessionId), JSON.stringify(value))
                  } catch {
                    setError(copy.storage)
                    return
                  }
                  selected.current = value
                  setSelection(value)
                  setError('')
                  setOpen(false)
                  inputActions.setDraft(choice.text)
                }}
              >
                <span className={css.head}>{choice.text}</span>
              </button>
            ))
          )}
          {error && <span className={css.error}>{error}</span>}
        </div>
      )}
    </div>
  )
}
