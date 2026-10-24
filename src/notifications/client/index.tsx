/** Background task notices through the official Client events and Web Notifications. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { TaskNotificationController } from './controller.ts'
import { TaskNoticeTracker } from './tracker.ts'
import { NotificationSection } from './NotificationSection.tsx'
import { zh, en, type NoticeLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.oplNotifications': NoticeLocaleKey
  }
}

export const inject = ['remote', 'remote.session', 'sessions', 'connection', 'slots', 'locale']

type SessionKey = Parameters<TaskNoticeTracker['status']>[0]
type SessionEventRow = {
  sessionId: SessionKey
  running: boolean
  origin?: 'subagent'
  displayTitle?: string
  projections?: unknown
}

function sessionTitle(row: SessionEventRow): string {
  if (typeof row.displayTitle === 'string') return row.displayTitle
  const values = (row.projections as { values?: { title?: unknown } } | undefined)?.values
  return typeof values?.title === 'string' ? values.title : row.sessionId
}

/** @param ctx - Official Client root. */
export function apply(ctx: Context): void {
  const ns = 'settings.oplNotifications'
  ctx.effect(() => ctx.locale.register(ns, { zh, en }))
  const controller = new TaskNotificationController(
    {
      // Access storage inside the controller's guarded calls, including the property getter.
      storage: {
        getItem: (key) => window.localStorage.getItem(key),
        setItem: (key, value) => window.localStorage.setItem(key, value),
      },
      permission: () =>
        typeof Notification === 'function' ? Notification.permission : 'unsupported',
      requestPermission: () => Notification.requestPermission(),
      foreground: () => document.visibilityState === 'visible' && document.hasFocus(),
      create: (title, options) => new Notification(title, options),
      focus: () => window.focus(),
    },
    ctx.locale.bind(ns),
  )
  const tracker = new TaskNoticeTracker()
  // rc.2 exports the Client handle but omits its Cordis Context augmentation.
  const connection = (ctx as Context & { connection: ConnectionHandle }).connection
  let generation = connection.generation.getSnapshot()?.id
  let disposed = false
  let revision = 0
  const observed = new Map<SessionKey, number>()
  const metadata = new Map<
    SessionKey,
    {
      displayTitle: string
      internal: boolean
    }
  >()
  const show = (id: SessionKey, kind: ReturnType<TaskNoticeTracker['status']>) => {
    if (!kind) return
    const row = ctx.sessions.list.getSnapshot().byId[id] as unknown as SessionEventRow | undefined
    const summary = row
      ? { displayTitle: row.displayTitle ?? row.sessionId, internal: row.origin === 'subagent' }
      : metadata.get(id)
    if (!summary || summary.internal || ctx.sessions.subagentAddress(id)) return
    controller.notify(id, summary.displayTitle, kind)
  }
  const baseline = async () => {
    const expected = generation
    if (expected === undefined) return
    const cut = revision
    let result
    try {
      result = await ctx.remote.session.list({})
    } catch (_error) {
      // A failed catalog read leaves live events authoritative; it never retries a task.
      return
    }
    if (disposed || expected !== generation || !result.ok) return
    for (const row of result.value.items as unknown as readonly SessionEventRow[]) {
      if ((observed.get(row.sessionId) ?? 0) > cut) continue
      metadata.set(row.sessionId, {
        displayTitle: sessionTitle(row),
        internal: row.origin === 'subagent',
      })
      // An active baseline arms a future live ending; an idle baseline never emits.
      if (row.running) tracker.status(row.sessionId, true)
    }
  }
  ctx.effect(() =>
    ctx.remote.$on('api-session/added', (row) => {
      const event = row as unknown as SessionEventRow
      observed.set(event.sessionId, ++revision)
      metadata.set(event.sessionId, {
        displayTitle: sessionTitle(event),
        internal: event.origin === 'subagent',
      })
      if (event.running) tracker.status(event.sessionId, true)
    }),
  )
  ctx.effect(() =>
    ctx.remote.$on('api-session/status', (id: SessionKey, running: boolean) => {
      observed.set(id, ++revision)
      show(id, tracker.status(id, running))
    }),
  )
  ctx.effect(() =>
    ctx.remote.$on('api-session/error', (id: SessionKey) => {
      observed.set(id, ++revision)
      show(id, tracker.failure(id))
    }),
  )
  ctx.effect(() =>
    ctx.remote.$on('api-session/removed', (id: SessionKey) => {
      observed.set(id, ++revision)
      tracker.remove(id)
      metadata.delete(id)
    }),
  )
  ctx.effect(() =>
    connection.generation.subscribe(() => {
      const next = connection.generation.getSnapshot()?.id
      if (next !== generation) {
        tracker.reset()
        metadata.clear()
        observed.clear()
        revision = 0
        generation = next
        void baseline()
      }
    }),
  )
  void baseline()
  ctx.effect(() => () => {
    disposed = true
    tracker.reset()
    metadata.clear()
    observed.clear()
    controller.dispose()
  })
  ctx.slots.inject('settings.general.item', () =>
    ctx.slots.register(
      {
        name: 'settings.general.item',
        id: 'opl-notifications',
        order: 50,
        locale: ns,
        inject: () => ({ controller }),
      },
      NotificationSection,
    ),
  )
}
