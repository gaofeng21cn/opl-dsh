import type {
  ComposerChainProps,
  InputActions,
  InputState,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'

type Props = ComposerChainProps & {
  readonly matched: object
  readonly useInput: SnapshotSelectorHook<InputState>
  readonly inputActions: InputActions
}

/**
 * The projectless Session composer occupies the official composer chain, so
 * it replaces the resident bar in that Session instead of adding a second
 * dialog beside it. Workspace Sessions decline the chain and keep the
 * official composer unchanged.
 */
export function ProjectlessComposer({ useInput, inputActions }: Props) {
  const input = useInput((state) => state)
  return (
    <div
      data-opl-projectless-composer=""
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
