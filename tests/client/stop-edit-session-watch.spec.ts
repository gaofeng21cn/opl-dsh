import { expect, it, vi } from 'vitest'
import { watchStopEditSession } from '../../src/execution/client/stop-edit-session-watch.ts'

it('refreshes each live run transition and stops observing after release', () => {
  const state = { running: false, blank: true, openState: 'open', other: 0 }
  const subscribers = new Set<() => void>()
  const session = {
    getSnapshot: () => state,
    subscribe: (callback: () => void) => {
      subscribers.add(callback)
      return () => {
        subscribers.delete(callback)
      }
    },
    update: (change: (value: typeof state) => void) => {
      change(state)
      subscribers.forEach((callback) => callback())
    },
  }
  const listener = vi.fn()
  const off = watchStopEditSession(session, listener)
  session.update((s) => {
    s.other++
  })
  expect(listener).not.toHaveBeenCalled()
  session.update((s) => {
    s.running = true
  })
  session.update((s) => {
    s.blank = false
  })
  session.update((s) => {
    s.running = false
  })
  expect(listener).toHaveBeenCalledTimes(3)
  off()
  session.update((s) => {
    s.running = true
  })
  expect(listener).toHaveBeenCalledTimes(3)
})
