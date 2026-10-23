/** One Session's message-edit selection, shared by message actions and recovery UI. */
import type { ExecutionCall } from '../../shared/client/remote-call.ts'
import type { MessageEditChoice, MessageEditState } from '../contracts/message-edit.ts'

export interface EditSelection {
  seq: number
  head: number
  previousDraft: string
}

export interface MessageEditSnapshot {
  state?: MessageEditState | undefined
  selection?: EditSelection | undefined
  error?: string | undefined
}

export const messageEditCopy = {
  cancel: '取消编辑',
  conflict: '输入框已有草稿，请先发送或清空',
  failed: '无法读取可编辑消息，请重试',
  storage: '无法保存编辑状态，请重试',
  stop: '请先停止当前对话',
  recover: '重试未确认的编辑',
} as const

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

/**
 * Own one Session's editable choices and selected target.
 *
 * Every message action and the exceptional recovery control observe this store,
 * so the row icon, the composer draft, and the prompt interceptor cannot drift
 * into separate selections.
 */
export class MessageEditSession {
  private snapshot: MessageEditSnapshot
  private readonly listeners = new Set<() => void>()
  private loadFlight: Promise<void> | undefined
  private loadGeneration = 0

  constructor(
    readonly sessionId: string,
    private readonly call: ExecutionCall,
  ) {
    this.snapshot = { selection: restored(sessionId) }
  }

  readonly getSnapshot = () => this.snapshot

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  choice(seq: number): MessageEditChoice | undefined {
    return this.snapshot.state?.choices.find((choice) => choice.seq === seq)
  }

  async load(): Promise<void> {
    if (this.loadFlight) return this.loadFlight
    const generation = ++this.loadGeneration
    const flight = this.call('message-edit-state', { sessionId: this.sessionId })
      .then((state) => {
        if (generation !== this.loadGeneration) return
        const selection = this.snapshot.selection
        if (
          selection &&
          !state.pending &&
          !state.choices.some((choice) => choice.seq === selection.seq)
        )
          this.removeSelection()
        this.publish({ ...this.snapshot, state, error: undefined })
      })
      .catch(() => {
        if (generation === this.loadGeneration)
          this.publish({ ...this.snapshot, error: messageEditCopy.failed })
      })
      .finally(() => {
        if (this.loadFlight === flight) this.loadFlight = undefined
      })
    this.loadFlight = flight
    return flight
  }

  async select(seq: number, draft: string): Promise<boolean> {
    if (draft) {
      this.publish({ ...this.snapshot, error: messageEditCopy.conflict })
      return false
    }
    if (!this.snapshot.state) await this.load()
    const state = this.snapshot.state
    const choice = state?.choices.find((candidate) => candidate.seq === seq)
    if (!state || !choice || !state.supported) {
      this.publish({ ...this.snapshot, error: messageEditCopy.failed })
      return false
    }
    if (state.busy || state.pending) {
      this.publish({ ...this.snapshot, error: messageEditCopy.stop })
      return false
    }
    const selection = { seq: choice.seq, head: state.head, previousDraft: draft }
    try {
      localStorage.setItem(keyFor(this.sessionId), JSON.stringify(selection))
    } catch {
      this.publish({ ...this.snapshot, error: messageEditCopy.storage })
      return false
    }
    this.publish({ ...this.snapshot, selection, error: undefined })
    return true
  }

  cancel(): EditSelection | undefined {
    const selection = this.snapshot.selection
    if (!selection) return
    try {
      localStorage.removeItem(keyFor(this.sessionId))
    } catch {
      this.publish({ ...this.snapshot, error: messageEditCopy.storage })
      return
    }
    this.removeSelection()
    return selection
  }

  accepted(): void {
    this.removeSelection()
  }

  async recover(): Promise<boolean> {
    const recovery = this.snapshot.state?.recovery
    if (!recovery) return false
    try {
      await this.call('message-edit-send', recovery)
      this.publish({ ...this.snapshot, error: undefined })
      return true
    } catch {
      this.publish({ ...this.snapshot, error: messageEditCopy.failed })
      return false
    }
  }

  dismissError(): void {
    if (!this.snapshot.error) return
    this.publish({ ...this.snapshot, error: undefined })
  }

  private removeSelection(): void {
    try {
      localStorage.removeItem(keyFor(this.sessionId))
    } catch {
      /* The in-memory owner must still release so a failed local write cannot send an edit. */
    }
    this.publish({ ...this.snapshot, selection: undefined })
  }

  private publish(next: MessageEditSnapshot): void {
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}
