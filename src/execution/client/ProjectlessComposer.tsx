import { useEffect } from 'react'
import type { InputActions, InputZone } from '@deepseek-ai/dsh-client-ui-conversation/client'

interface WorkspaceState {
  readonly items: readonly {
    readonly sessionIds: readonly string[]
  }[]
}

type Props = InputZone & {
  inputActions: InputActions
  useWorkspaces: <Selected>(selector: (state: WorkspaceState) => Selected) => Selected
}

/**
 * Provides the first draft surface for an ungrouped blank Session.
 *
 * The official Conversation intentionally disables its Hero composer until a
 * Workspace is selected. An ungrouped Session is already created and selected,
 * so this small surface owns only its initial text and submit action.
 */
export function ProjectlessComposer({ session, input, inputActions, useWorkspaces }: Props) {
  const projectless = useWorkspaces(
    (state) => !state.items.some((workspace) => workspace.sessionIds.includes(session.sessionId)),
  )

  useEffect(() => {
    if (!projectless) return
    const dock = document.querySelector<HTMLElement>(
      `[data-opl-projectless-composer="${session.sessionId}"]`,
    )
    const bar = dock?.parentElement?.querySelector<HTMLElement>(
      '[data-slot="conversation.composer.bar"]',
    )
    if (!bar) return
    bar.hidden = true
    return () => {
      bar.hidden = false
    }
  }, [projectless, session.sessionId])

  if (!projectless) return null

  return (
    <div
      data-opl-projectless-composer={session.sessionId}
      style={{ display: 'flex', gap: 8, padding: '8px 12px 6px', width: '100%' }}
    >
      <textarea
        aria-label="项目外会话输入"
        placeholder="输入消息"
        rows={2}
        value={input.draft}
        onChange={(event) => inputActions.setDraft(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            inputActions.submit()
          }
        }}
        style={{ flex: 1, resize: 'vertical', minHeight: 44, padding: 8 }}
      />
      <button
        type="button"
        aria-label="发送项目外会话消息"
        disabled={input.draft.trim() === '' || input.phase !== 'plain'}
        onClick={() => inputActions.submit()}
        style={{ alignSelf: 'flex-end', minHeight: 32 }}
      >
        发送
      </button>
    </div>
  )
}
