/** Renderer-owned system notifications; no Desktop resources or private IPC are changed. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { NoticeLocaleKey } from './locales.ts'
import type { TaskNotice } from './tracker.ts'

const preferenceKey = 'opl.task-notifications.enabled.v1'
export type NoticeStatus = 'ready' | 'permission' | 'denied' | 'unsupported' | 'sent' | 'failure'
type Translator = (key: NoticeLocaleKey) => string

/** Browser operations owned by the one mounted Client plugin. */
export interface NotificationEnvironment {
  storage: Pick<Storage, 'getItem' | 'setItem'>
  permission(): NotificationPermission | 'unsupported'
  requestPermission(): Promise<NotificationPermission>
  foreground(): boolean
  create(title: string, options: NotificationOptions): Notification
  focus(): void
}

/** Persist the toggle and supervise only notifications created by this plugin. */
export class TaskNotificationController {
  readonly state = createSnapshotStore({
    enabled: true,
    status: 'ready' as NoticeStatus,
    savingFailed: false,
  })
  private readonly live = new Set<Notification>()
  private disposed = false

  /** @param env - Browser environment. @param t - Locale binding. */
  constructor(
    private readonly env: NotificationEnvironment,
    private readonly t: Translator,
  ) {
    let enabled = true
    let savingFailed = false
    try {
      enabled = env.storage.getItem(preferenceKey) !== 'false'
    } catch (_error) {
      // A restricted browser may deny storage; keep the in-memory preference.
      savingFailed = true
    }
    this.state.set({ enabled, status: this.permissionStatus(), savingFailed })
  }

  /** @param enabled - Whether background tasks may notify. */
  setEnabled(enabled: boolean): void {
    if (this.disposed) return
    let savingFailed = false
    try {
      this.env.storage.setItem(preferenceKey, String(enabled))
    } catch (_error) {
      // Report storage denial in settings without undoing the current selection.
      savingFailed = true
    }
    this.state.update((state) => {
      state.enabled = enabled
      state.savingFailed = savingFailed
    })
  }

  /** @param id - Session identity for OS deduplication. @param title - Public catalog title. @param kind - Observed terminal status. */
  notify(id: SessionId, title: string, kind: TaskNotice): void {
    if (this.disposed || !this.state.getSnapshot().enabled || this.env.foreground()) return
    if (this.env.permission() !== 'granted') {
      this.updateStatus(this.permissionStatus())
      return
    }
    // Newline/control removal keeps a catalog title from imitating OS status text.
    const body = Array.from(title.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim())
      .slice(0, 120)
      .join('')
    this.show(this.t(kind), { body, tag: 'opl-task:' + id })
  }

  /** Request permission only from the settings button; the test also works in the foreground. */
  async test(): Promise<void> {
    if (this.disposed) return
    try {
      if (this.env.permission() === 'default') await this.env.requestPermission()
      if (this.disposed) return
      if (this.env.permission() !== 'granted') {
        this.updateStatus(this.permissionStatus())
        return
      }
      this.show(this.t('testTitle'), { body: this.t('testBody'), tag: 'opl-task:test' })
    } catch (_error) {
      // Browser errors can contain environment details; display a fixed diagnostic.
      this.updateStatus('failure')
    }
  }

  /** Close owned toasts and detach callbacks on Client plugin unload. */
  dispose(): void {
    this.disposed = true
    for (const notice of this.live) {
      notice.onshow = notice.onerror = notice.onclick = notice.onclose = null
      notice.close()
    }
    this.live.clear()
  }

  private permissionStatus(): NoticeStatus {
    const permission = this.env.permission()
    return permission === 'granted' ? 'ready' : permission === 'default' ? 'permission' : permission
  }

  private updateStatus(status: NoticeStatus): void {
    if (!this.disposed)
      this.state.update((state) => {
        state.status = status
      })
  }

  private show(title: string, options: NotificationOptions): void {
    try {
      const notice = this.env.create(title, options)
      this.live.add(notice)
      notice.onshow = () => this.updateStatus('sent')
      notice.onerror = () => {
        this.updateStatus('failure')
        this.live.delete(notice)
      }
      notice.onclose = () => this.live.delete(notice)
      notice.onclick = () => {
        if (!this.disposed) this.env.focus()
        notice.close()
      }
    } catch (_error) {
      // Fixed settings feedback avoids leaking browser or operating-system errors.
      this.updateStatus('failure')
    }
  }
}
