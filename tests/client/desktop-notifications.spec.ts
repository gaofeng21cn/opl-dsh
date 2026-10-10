import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { TaskNoticeTracker } from '../../src/notifications/client/tracker.ts'
import {
  TaskNotificationController,
  type NotificationEnvironment,
} from '../../src/notifications/client/controller.ts'
import { apply } from '../../src/notifications/client/index.tsx'
import { zh } from '../../src/notifications/client/locales.ts'

// Desktop owns the store's Zustand/Immer peers. This unit adapter supplies only
// observable snapshots; isolated official Desktop acceptance uses the real store.
vi.mock('@deepseek-ai/dsh-client-store', () => ({
  createSnapshotStore: <T>(initial: T) => {
    let snapshot = initial
    const listeners = new Set<() => void>()
    const set = (value: T) => {
      snapshot = value
      listeners.forEach((listener) => listener())
    }
    return {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      set,
      update: (mutate: (value: T) => void) => {
        const value = structuredClone(snapshot)
        mutate(value)
        set(value)
      },
    }
  },
}))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Button: () => null, Switch: () => null }))

const id = 'notification-test' as SessionId
const child = 'notification-child' as SessionId

function environment() {
  let permission: NotificationPermission | 'unsupported' = 'granted'
  let foreground = false
  const values = new Map<string, string>()
  const notices: Array<{ title: string; options: NotificationOptions; notice: Notification }> = []
  const focus = vi.fn()
  const env: NotificationEnvironment = {
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value)
      },
    },
    permission: () => permission,
    requestPermission: vi.fn(async () => {
      permission = 'granted'
      return 'granted' as const
    }),
    foreground: () => foreground,
    create: (title, options) => {
      const notice = {
        close: vi.fn(),
        onshow: null,
        onerror: null,
        onclose: null,
        onclick: null,
      } as unknown as Notification
      notices.push({ title, options, notice })
      return notice
    },
    focus,
  }
  return {
    env,
    notices,
    values,
    focus,
    permission: (value: typeof permission) => {
      permission = value
    },
    foreground: (value: boolean) => {
      foreground = value
    },
  }
}
function fire(notice: Notification, type: 'show' | 'error' | 'click' | 'close') {
  const handler = notice[('on' + type) as 'onshow' | 'onerror' | 'onclick' | 'onclose']
  handler?.call(notice, new Event(type))
}

afterEach(() => vi.unstubAllGlobals())

describe('live task notification transitions', () => {
  it('ignores idle baselines, deduplicates statuses, and starts a fresh notice for each run', () => {
    const tracker = new TaskNoticeTracker()
    expect(tracker.status(id, false)).toBeUndefined()
    tracker.status(id, true)
    tracker.status(id, true)
    expect(tracker.status(id, false)).toBe('ended')
    expect(tracker.status(id, false)).toBeUndefined()
    tracker.status(id, true)
    expect(tracker.status(id, false)).toBe('ended')
  })
  it('reports one failure, suppresses its ending, and does not turn disconnect or removal into completion', () => {
    const tracker = new TaskNoticeTracker()
    expect(tracker.failure(id)).toBeUndefined()
    tracker.status(id, true)
    expect(tracker.failure(id)).toBe('failed')
    tracker.status(id, true)
    expect(tracker.failure(id)).toBeUndefined()
    expect(tracker.status(id, false)).toBeUndefined()
    tracker.status(id, true)
    tracker.reset()
    expect(tracker.status(id, false)).toBeUndefined()
    tracker.status(id, true)
    tracker.remove(id)
    expect(tracker.status(id, false)).toBeUndefined()
  })
})

describe('system notification delivery and settings', () => {
  it('suppresses foreground or disabled tasks without replay and preserves the toggle across mounts', () => {
    const harness = environment()
    const controller = new TaskNotificationController(harness.env, (key) => zh[key])
    harness.foreground(true)
    controller.notify(id, '任务标题', 'ended')
    harness.foreground(false)
    controller.setEnabled(false)
    controller.notify(id, '任务标题', 'failed')
    expect(harness.notices).toHaveLength(0)
    const restored = new TaskNotificationController(harness.env, (key) => zh[key])
    expect(restored.state.getSnapshot().enabled).toBe(false)
    restored.setEnabled(true)
    restored.notify(id, '任务标题', 'ended')
    expect(harness.notices.map((entry) => entry.title)).toEqual(['任务已结束'])
  })
  it('sends only a bounded catalog title, focuses on click, and detaches callbacks on disposal', () => {
    const harness = environment()
    const controller = new TaskNotificationController(harness.env, (key) => zh[key])
    controller.notify(id, '\n' + '文'.repeat(150) + '\u0000', 'failed')
    const { options, notice } = harness.notices[0]!
    expect(options).toEqual({ body: '文'.repeat(120), tag: 'opl-task:notification-test' })
    fire(notice, 'show')
    expect(controller.state.getSnapshot().status).toBe('sent')
    fire(notice, 'click')
    expect(harness.focus).toHaveBeenCalledOnce()
    expect(notice.close).toHaveBeenCalledOnce()
    controller.dispose()
    expect(notice.onclick).toBeNull()
    controller.notify(id, 'after unload', 'ended')
    expect(harness.notices).toHaveLength(1)
  })
  it('requests permission only for an explicit test, reports denial and rejects late permission results after unload', async () => {
    const harness = environment()
    harness.permission('default')
    const controller = new TaskNotificationController(harness.env, (key) => zh[key])
    controller.notify(id, 'task', 'ended')
    expect(harness.env.requestPermission).not.toHaveBeenCalled()
    await controller.test()
    expect(harness.env.requestPermission).toHaveBeenCalledOnce()
    expect(harness.notices[0]!.title).toBe('OPL DSH 通知测试')
    harness.permission('denied')
    await controller.test()
    expect(controller.state.getSnapshot().status).toBe('denied')
    expect(harness.notices).toHaveLength(1)
    harness.permission('default')
    harness.env.requestPermission = async () => {
      controller.dispose()
      return 'granted'
    }
    await controller.test()
    expect(harness.notices).toHaveLength(1)
  })
  it('reports storage and native delivery failures without displaying thrown environment data', () => {
    const harness = environment()
    harness.env.storage.setItem = () => {
      throw Error('private environment data')
    }
    const controller = new TaskNotificationController(harness.env, (key) => zh[key])
    controller.setEnabled(false)
    expect(controller.state.getSnapshot()).toMatchObject({ enabled: false, savingFailed: true })
    controller.setEnabled(true)
    controller.notify(id, 'task', 'ended')
    fire(harness.notices[0]!.notice, 'error')
    expect(controller.state.getSnapshot().status).toBe('failure')
    harness.env.create = () => {
      throw Error('private environment data')
    }
    controller.notify(id, 'task', 'ended')
    expect(controller.state.getSnapshot().status).toBe('failure')
  })
})

it('mounts real public event listeners: root and harness runs notify, internal subagents and reconnect baselines do not', () => {
  const harness = environment()
  class BrowserNotification {
    static permission = 'granted'
    constructor(title: string, options: NotificationOptions) {
      return harness.env.create(title, options)
    }
  }
  vi.stubGlobal('Notification', BrowserNotification)
  vi.stubGlobal('window', { localStorage: harness.env.storage, focus: harness.focus })
  vi.stubGlobal('document', { visibilityState: 'hidden', hasFocus: () => false })
  const listeners = new Map<string, (...args: unknown[]) => void>()
  const cleanups: Array<() => void> = []
  let generation: { id: number } | undefined = { id: 1 }
  let generationChanged = () => {}
  const rows = {
    [id]: { displayTitle: 'M3.1 实际任务' },
    [child]: { displayTitle: '内部子任务', origin: 'subagent' },
  }
  const ctx = {
    effect: (factory: () => () => void) => {
      cleanups.push(factory())
    },
    remote: {
      session: { list: async () => ({ ok: true, value: { items: [] } }) },
      $on: (name: string, listener: (...args: unknown[]) => void) => {
        listeners.set(name, listener)
        return () => {
          listeners.delete(name)
        }
      },
    },
    sessions: { list: { getSnapshot: () => ({ byId: rows }) }, subagentAddress: () => undefined },
    connection: {
      generation: {
        getSnapshot: () => generation,
        subscribe: (listener: () => void) => {
          generationChanged = listener
          return () => {
            generationChanged = () => {}
          }
        },
      },
    },
    locale: { register: () => () => {}, bind: () => (key: keyof typeof zh) => zh[key] },
    slots: {
      inject: (_seat: string, install: () => unknown) => {
        cleanups.push(install() as () => void)
      },
      register: () => () => {},
    },
  } as unknown as Context
  apply(ctx)
  const status = (session: SessionId, running: boolean) =>
    listeners.get('api-session/status')!(session, running)
  status(id, false)
  status(child, true)
  status(child, false)
  status(id, true)
  status(id, false)
  status(id, false)
  status(id, true)
  listeners.get('api-session/error')!(id, 'secret tool diagnostic')
  status(id, false)
  status(id, true)
  generation = undefined
  generationChanged()
  generation = { id: 2 }
  generationChanged()
  status(id, false)
  expect(harness.notices.map(({ title, options }) => ({ title, body: options.body }))).toEqual([
    { title: '任务已结束', body: 'M3.1 实际任务' },
    { title: '任务失败', body: 'M3.1 实际任务' },
  ])
  cleanups.reverse().forEach((dispose) => dispose())
  expect(listeners.size).toBe(0)
})

function mountedNotifications() {
  const harness = environment()
  class BrowserNotification {
    static permission = 'granted'
    constructor(title: string, options: NotificationOptions) {
      return harness.env.create(title, options)
    }
  }
  vi.stubGlobal('Notification', BrowserNotification)
  vi.stubGlobal('window', { localStorage: harness.env.storage, focus: harness.focus })
  // An occluded window can stay visible while losing focus.
  vi.stubGlobal('document', { visibilityState: 'visible', hasFocus: () => false })
  const listeners = new Map<string, (...args: unknown[]) => void>()
  const cleanups: Array<() => void> = []
  let generation: { id: number } | undefined = { id: 1 }
  let changed = () => {}
  const reads: Array<
    ReturnType<
      typeof Promise.withResolvers<{
        ok: true
        value: { items: Array<{ sessionId: SessionId; running: boolean }> }
      }>
    >
  > = []
  const rows: Record<string, { displayTitle: string; origin?: string }> = {}
  const ctx = {
    effect: (factory: () => () => void) => cleanups.push(factory()),
    remote: {
      session: {
        list: () => {
          // This adapter models wire responses without accessing a real account.
          const read = Promise.withResolvers<{
            ok: true
            value: { items: Array<{ sessionId: SessionId; running: boolean }> }
          }>()
          reads.push(read)
          return read.promise
        },
      },
      $on: (name: string, listener: (...args: unknown[]) => void) => {
        listeners.set(name, listener)
        return () => {
          listeners.delete(name)
        }
      },
    },
    sessions: { list: { getSnapshot: () => ({ byId: rows }) }, subagentAddress: () => undefined },
    connection: {
      generation: {
        getSnapshot: () => generation,
        subscribe: (listener: () => void) => {
          changed = listener
          return () => {
            changed = () => {}
          }
        },
      },
    },
    locale: { register: () => () => {}, bind: () => (key: keyof typeof zh) => zh[key] },
    slots: {
      inject: (_seat: string, install: () => unknown) => cleanups.push(install() as () => void),
      register: () => () => {},
    },
  } as unknown as Context
  apply(ctx)
  return {
    harness,
    reads,
    rows,
    emit: (name: string, ...args: unknown[]) => listeners.get(name)!(...args),
    generation: (value: typeof generation) => {
      generation = value
      changed()
    },
    dispose: () => cleanups.reverse().forEach((cleanup) => cleanup()),
  }
}
const runningRow = {
  sessionId: id,
  projections: { values: { title: 'CLI 派发任务' } },
  running: true,
}
const idleRow = { sessionId: child, title: '旧结束任务', running: false }

it('arms active tasks after Client mount and reconnect without replaying idle histories', async () => {
  const mounted = mountedNotifications()
  try {
    mounted.reads[0]!.resolve({ ok: true, value: { items: [runningRow, idleRow] } })
    await Promise.resolve()
    expect(mounted.harness.notices).toHaveLength(0)
    mounted.emit('api-session/status', id, false)
    mounted.emit('api-session/status', child, false)
    expect(mounted.harness.notices).toHaveLength(1)
    mounted.generation(undefined)
    mounted.generation({ id: 2 })
    mounted.reads[1]!.resolve({ ok: true, value: { items: [runningRow, idleRow] } })
    await Promise.resolve()
    mounted.emit('api-session/error', id, 'private failure')
    mounted.emit('api-session/status', id, false)
    expect(mounted.harness.notices.map(({ title }) => title)).toEqual(['任务已结束', '任务失败'])
  } finally {
    mounted.dispose()
  }
})

it('notifies CLI additions before the sidebar has published their rows and keeps internal children silent', () => {
  const mounted = mountedNotifications()
  try {
    mounted.emit('api-session/added', runningRow)
    mounted.emit('api-session/status', id, true)
    mounted.emit('api-session/status', id, false)
    mounted.emit('api-session/added', { ...runningRow, sessionId: child, origin: 'subagent' })
    mounted.emit('api-session/status', child, false)
    expect(mounted.harness.notices.map(({ options }) => options.body)).toEqual(['CLI 派发任务'])
  } finally {
    mounted.dispose()
  }
})

it('does not rearm an ended or removed task from a late running baseline', async () => {
  const mounted = mountedNotifications()
  try {
    mounted.emit('api-session/added', runningRow)
    mounted.emit('api-session/status', id, false)
    mounted.emit('api-session/removed', child)
    mounted.reads[0]!.resolve({
      ok: true,
      value: { items: [runningRow, { ...runningRow, sessionId: child }] },
    })
    await Promise.resolve()
    mounted.emit('api-session/status', id, false)
    mounted.emit('api-session/status', child, false)
    expect(mounted.harness.notices).toHaveLength(1)
  } finally {
    mounted.dispose()
  }
})

it('fences baseline replies from lost connections and disposed notification plugins', async () => {
  const mounted = mountedNotifications()
  mounted.generation({ id: 2 })
  mounted.reads[0]!.resolve({ ok: true, value: { items: [runningRow] } })
  await Promise.resolve()
  mounted.emit('api-session/status', id, false)
  expect(mounted.harness.notices).toHaveLength(0)
  mounted.dispose()
  mounted.reads[1]!.resolve({ ok: true, value: { items: [runningRow] } })
  await Promise.resolve()
  expect(mounted.harness.notices).toHaveLength(0)
})

it('contains a rejected baseline read and continues delivering later live CLI runs', async () => {
  const mounted = mountedNotifications()
  try {
    mounted.reads[0]!.reject(Error('private transport details'))
    await Promise.resolve()
    mounted.emit('api-session/added', runningRow)
    mounted.emit('api-session/status', id, false)
    expect(mounted.harness.notices).toHaveLength(1)
    expect(mounted.reads).toHaveLength(1)
  } finally {
    mounted.dispose()
  }
})
