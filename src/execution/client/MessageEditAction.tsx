/** Message-local edit action, placed beside the official copy action. */
import { useSyncExternalStore } from 'react'
import { IconEditOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MessageEditSession } from './message-edit-session.ts'
import css from './MessageEditAction.module.css'

export function MessageEditAction({
  session,
  seq,
  draft,
  onDraft,
}: {
  session: MessageEditSession
  seq: number
  draft: string
  onDraft(text: string): void
}) {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
  const choice = session.choice(seq)
  if (!choice) return null
  const busy = snapshot.state?.busy === true || snapshot.state?.pending === true
  return (
    <Tooltip label={busy ? '请先停止当前对话' : '编辑消息'} side="bottom">
      <button
        type="button"
        className={css.action}
        aria-label="编辑消息"
        aria-disabled={busy || undefined}
        data-unavailable={busy || undefined}
        onClick={async () => {
          if (busy) return
          if (await session.select(seq, draft)) onDraft(choice.text)
        }}
      >
        <IconEditOutlineRegular />
      </button>
    </Tooltip>
  )
}
