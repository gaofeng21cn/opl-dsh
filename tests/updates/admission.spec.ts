/** Admission exclusion, non-invasive Host activity inspection, and update freeze state. */
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  UpdateAdmission,
  assertSuiteAdmission,
  drainUpdateActivity,
  inspectUpdateActivity,
  type UpdateActivityCalls,
} from '../../src/updates/host/admission.ts'
import { installUpdateRuntime } from '../../src/updates/host/runtime-admission.ts'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cleanups: (() => void | Promise<unknown>)[] = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

describe('Suite-wide update admission', () => {
  it('blocks other profiles once an update transaction owns the Suite lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opl-suite-admission-'))
    try {
      const gate = new UpdateAdmission(() => assertSuiteAdmission(root))
      const lock = join(root, 'enhancement-transaction.lock')
      await expect(gate.admit(() => 'ready')).resolves.toBe('ready')
      await writeFile(
        lock,
        JSON.stringify({ kind: 'update', id: 'update', nonce: 'nonce', pid: 1 }),
      )
      expect(() => gate.admitSync(() => 'must not start')).toThrow('正在准备或应用更新')
      await rm(lock)
      expect(gate.admitSync(() => 'ready')).toBe('ready')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails closed for an unreadable update-lock record but allows a verified maintenance lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opl-suite-admission-'))
    try {
      await writeFile(join(root, 'enhancement-transaction.lock'), '{')
      expect(() => assertSuiteAdmission(root)).toThrow('更新锁无效')
      await writeFile(
        join(root, 'enhancement-transaction.lock'),
        JSON.stringify({ kind: 'maintenance', id: 'maintenance', nonce: 'nonce', pid: 1 }),
      )
      expect(() => assertSuiteAdmission(root)).not.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function deferred<T>() {
  return Promise.withResolvers<T>()
}

const message = () =>
  createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'continue' }] })

/** A public Agent implementation with a real Session log and synchronous input methods. */
class TestAgent {
  readonly session: Session
  readonly id: SessionId
  readonly inbox = { nextTurn: [] as UserMessage[], nextStep: [] as UserMessage[] }
  status: 'idle' | 'running' = 'idle'
  private maintenance: Promise<unknown> | undefined

  constructor(
    readonly ctx: Context,
    id = 'session-input',
  ) {
    this.id = SessionId(id)
    this.session = Session.create(this.id)
  }

  send(input: UserMessage, target: 'next-turn' | 'next-step', wakeup: boolean): void {
    const queue = target === 'next-turn' ? this.inbox.nextTurn : this.inbox.nextStep
    this.session.append('agent/inbox/spliced', { target, start: queue.length, inserted: [input] })
    queue.push(input)
    if (wakeup) this.status = 'running'
  }
  followup(input: UserMessage): void {
    this.send(input, 'next-turn', true)
  }
  steer(input: UserMessage): void {
    this.send(input, 'next-step', true)
  }
  inject(input: UserMessage): void {
    this.send(input, 'next-step', false)
  }
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.maintenance) throw Error('maintenance already active')
    const result = task(new AbortController().signal)
    this.maintenance = result
    return result.finally(() => {
      this.maintenance = undefined
    })
  }
  whenIdle(): Promise<void> {
    return (
      this.maintenance?.then(
        () => undefined,
        () => undefined,
      ) ?? Promise.resolve()
    )
  }
}

function nativeFixture(officialController = false, install = true, gate = new UpdateAdmission()) {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  const agent = new TestAgent(ctx)
  const live = [agent]
  const barrier = deferred<void>()
  const commands = {
    prompt: vi.fn(async () => {
      await barrier.promise
      agent.followup(message())
      return { accepted: true }
    }),
    create: vi.fn(async () => ({})),
    selectModel: vi.fn(async () => ({})),
    fork: vi.fn(async () => ({})),
    updateQueue: vi.fn(async () => ({})),
  }
  const spies = { ...commands }
  if (officialController) new SessionController(ctx, { nativeOpen: false })
  else ctx.provide('sessionController', commands as never)
  const registry = {
    list: () => [...live],
    get: (id: SessionId) => live.find((item) => item.id === id),
    create: vi.fn(async () => ({})),
    resume: vi.fn(async () => ({})),
  }
  ctx.provide('agents', registry as never)
  if (install) installUpdateAdmission(ctx, gate)
  return { ctx, gate, agent, live, commands, spies, registry, barrier }
}

describe('update admission exclusion', () => {
  it('reserves before the operation reaches its first await and drains through settlement', async () => {
    const gate = new UpdateAdmission()
    const barrier = deferred<number>()
    let entered = false
    const work = gate.admit(async () => {
      entered = true
      expect(gate.inspect().pending).toBe(1)
      return await barrier.promise
    })
    expect(entered).toBe(true)
    expect(() => gate.freeze()).toThrow('活动任务或启动请求')
    expect(gate.inspect()).toEqual({ pending: 1, frozen: false, closed: false })
    let drained = false
    const drain = gate.drain().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    barrier.resolve(42)
    expect(await work).toBe(42)
    await drain
    expect(drained).toBe(true)
    gate.freeze().release()
  })

  it('freezes synchronously and prevents an old lease from releasing a newer freeze', async () => {
    const gate = new UpdateAdmission()
    const input = vi.fn(() => 1)
    const first = gate.freeze()
    expect(() => gate.admit(input)).toThrow('正在应用更新')
    expect(() => gate.admitSync(input)).toThrow('正在应用更新')
    expect(() => gate.freeze()).toThrow('正在应用更新')
    expect(input).not.toHaveBeenCalled()
    first.release()
    const second = gate.freeze()
    first.release()
    expect(() => gate.assertAvailable()).toThrow('正在应用更新')
    second.release()
    expect(await gate.admit(input)).toBe(1)
  })

  it('releases rejected, thrown and reentrant synchronous admissions', async () => {
    const gate = new UpdateAdmission()
    const failure = Error('admission failed')
    expect(() =>
      gate.admit(() => {
        throw failure
      }),
    ).toThrow(failure)
    await expect(gate.admit(() => Promise.reject(failure))).rejects.toBe(failure)
    expect(() =>
      gate.admitSync(() => {
        expect(() => gate.freeze()).toThrow('活动任务或启动请求')
        throw failure
      }),
    ).toThrow(failure)
    expect(gate.inspect().pending).toBe(0)
    gate.freeze().release()
  })

  it('closes before draining and never reopens when an existing update lease releases', async () => {
    const gate = new UpdateAdmission()
    const barrier = deferred<void>()
    const work = gate.admit(() => barrier.promise)
    let closed = false
    const closing = gate.close().then(() => {
      closed = true
    })
    expect(() => gate.admit(() => undefined)).toThrow('已关闭')
    await Promise.resolve()
    expect(closed).toBe(false)
    barrier.resolve()
    await Promise.all([work, closing])
    expect(gate.inspect()).toEqual({ pending: 0, frozen: false, closed: true })
    const frozen = new UpdateAdmission()
    const lease = frozen.freeze()
    await frozen.close()
    lease.release()
    expect(() => frozen.assertAvailable()).toThrow('已关闭')
  })
})

function runtimeFixture() {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  const agent = new TestAgent(ctx)
  const live = [agent]
  const commands = {
    prompt: vi.fn(async () => ({ accepted: true })),
    create: vi.fn(async () => ({})),
    selectModel: vi.fn(async () => ({})),
    fork: vi.fn(async () => ({})),
    updateQueue: vi.fn(async () => ({})),
  }
  const registry = {
    list: () => [...live],
    get: (id: SessionId) => live.find((item) => item.id === id),
    create: vi.fn(async () => ({})),
    resume: vi.fn(async () => ({})),
  }
  const settings = {
    update: vi.fn(async () => {}),
    mutate: vi.fn(async () => {}),
  }
  const harness = {
    updateBusy: vi.fn(() => false),
    drainForUpdate: vi.fn(async () => {}),
  }
  const feedback = {
    tasks: vi.fn(() => []),
  }
  ctx.provide('sessionController', commands as never)
  ctx.provide('agents', registry as never)
  ctx.provide('sessions', { list: () => live.map((item) => item.session) } as never)
  ctx.provide('workspaceRegistry', { list: () => [] } as never)
  ctx.provide('settings', settings as never)
  ctx.provide('taskFeedback', feedback as never)
  const runtime = installUpdateRuntime(ctx, harness as never)
  return { ctx, agent, live, commands, registry, settings, harness, feedback, runtime }
}

describe('non-invasive update runtime', () => {
  it('never patches own method descriptors on official services or live Agents', async () => {
    const controller = {
      prompt: async () => ({}),
      create: async () => ({}),
      selectModel: async () => ({}),
      fork: async () => ({}),
      updateQueue: async () => ({}),
    }
    const agent = new TestAgent(new Context())
    const registry = {
      list: () => [agent],
      get: (id: SessionId) => (id === agent.id ? agent : undefined),
      create: async () => ({}),
      resume: async () => ({}),
    }
    const settings = { update: async () => {}, mutate: async () => {} }
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    ctx.provide('sessionController', controller as never)
    ctx.provide('agents', registry as never)
    ctx.provide('sessions', { list: () => [agent.session] } as never)
    ctx.provide('workspaceRegistry', { list: () => [] } as never)
    ctx.provide('settings', settings as never)

    const beforeController = Object.getOwnPropertyDescriptors(controller)
    const beforeRegistry = Object.getOwnPropertyDescriptors(registry)
    const beforeSettings = Object.getOwnPropertyDescriptors(settings)
    const beforeAgent = Object.getOwnPropertyDescriptors(agent)

    const runtime = installUpdateRuntime(ctx)

    expect(Object.getOwnPropertyDescriptors(controller)).toEqual(beforeController)
    expect(Object.getOwnPropertyDescriptors(registry)).toEqual(beforeRegistry)
    expect(Object.getOwnPropertyDescriptors(settings)).toEqual(beforeSettings)
    expect(Object.getOwnPropertyDescriptors(agent)).toEqual(beforeAgent)

    const created = new TestAgent(ctx, 'session-created')
    const beforeCreated = Object.getOwnPropertyDescriptors(created)
    await ctx.serial('agent/created', {
      agent: created as never,
      source: 'startup',
      signal: new AbortController().signal,
    })
    expect(Object.getOwnPropertyDescriptors(created)).toEqual(beforeCreated)
    for (const method of ['send', 'followup', 'steer', 'inject', 'runMaintenance', 'whenIdle']) {
      expect(Object.hasOwn(created, method)).toBe(false)
    }
    expect(await runtime.inspect()).toBe(true)
  })

  it('refuses freeze when live work is active and drains idle Agents before releasing', async () => {
    const f = runtimeFixture()
    const maintenance = deferred<void>()
    const task = f.agent.runMaintenance(() => maintenance.promise)
    let release!: () => void
    const freezing = f.runtime.freeze().then((done) => {
      release = done
    })
    await Promise.resolve()
    expect(f.harness.drainForUpdate).not.toHaveBeenCalled()
    maintenance.resolve()
    await Promise.all([task, freezing])
    expect(f.harness.drainForUpdate).toHaveBeenCalledOnce()
    expect(() => f.runtime.assertAvailable?.()).toThrow('正在应用更新')
    release()
    expect(() => f.runtime.assertAvailable?.()).not.toThrow()
  })

  it('aborts freeze when Harness or feedback reports busy activity', async () => {
    const f = runtimeFixture()
    f.harness.updateBusy.mockReturnValue(true)
    await expect(f.runtime.freeze()).rejects.toThrow('仍有任务活动')
    f.harness.updateBusy.mockReturnValue(false)
    f.feedback.tasks.mockReturnValue([{ state: 'running' }] as never)
    await expect(f.runtime.freeze()).rejects.toThrow('仍有任务活动')
    f.feedback.tasks.mockReturnValue([])
    const release = await f.runtime.freeze()
    release()
  })
})

function activityFixture() {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  const agent = new TestAgent(ctx)
  ctx.provide('agents', { list: () => [agent] } as never)
  ctx.provide('sessions', { list: () => [agent.session] } as never)
  const cold = SessionId('session-cold-project')
  ctx.provide('workspaceRegistry', {
    list: () => [{ sessionIds: [cold, agent.id] }],
  } as never)
  const calls: UpdateActivityCalls = {
    harness: vi.fn(async () => ({ busy: false })),
    feedbackTasks: vi.fn<UpdateActivityCalls['feedbackTasks']>(async () => [
      { state: 'completed' },
      { state: 'disconnected' },
    ]),
  }
  return { ctx, agent, cold, calls }
}

describe('update activity inspection', () => {
  it('drains idle maintenance that started before guards were installed', async () => {
    const f = activityFixture()
    const barrier = deferred<void>()
    const maintenance = f.agent.runMaintenance(() => barrier.promise)
    const gate = new UpdateAdmission()
    const lease = gate.freeze()
    let drained = false
    const drain = drainUpdateActivity(f.ctx, new AbortController().signal).then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    expect(f.agent.status).toBe('idle')
    barrier.resolve()
    await Promise.all([maintenance, drain])
    expect(drained).toBe(true)
    lease.release()
  })

  it('cancels an outstanding native drain and removes its abort listener', async () => {
    const f = activityFixture()
    const barrier = deferred<void>()
    const maintenance = f.agent.runMaintenance(() => barrier.promise)
    const abort = new AbortController()
    const off = vi.spyOn(abort.signal, 'removeEventListener')
    const drain = drainUpdateActivity(f.ctx, abort.signal)
    const failure = Error('drain deadline')
    abort.abort(failure)
    await expect(drain).rejects.toBe(failure)
    expect(off).toHaveBeenCalledWith('abort', expect.any(Function))
    barrier.resolve()
    await maintenance
    await expect(drainUpdateActivity(f.ctx, abort.signal)).rejects.toBe(failure)
  })

  it('asks real activity providers for every live and project-owned Session, without duplicate reads', async () => {
    const f = activityFixture()
    const seen: SessionId[] = []
    f.ctx.on('workspace/session-activity', async ({ sessionId }, next) => {
      seen.push(sessionId)
      const rest = await next()
      return sessionId === f.cold ? [{ kind: 'schedule' } as never, ...rest] : rest
    })
    expect(await inspectUpdateActivity(f.ctx, f.calls)).toEqual({
      idle: false,
      reasons: ['session'],
    })
    expect(seen).toEqual([f.agent.id, f.cold])
    expect(f.calls.harness).toHaveBeenCalledOnce()
    expect(f.calls.feedbackTasks).toHaveBeenCalledOnce()
  })

  it('allows completed feedback history and detects queued input, pending admission and active Harness work', async () => {
    const f = activityFixture()
    expect(await inspectUpdateActivity(f.ctx, f.calls)).toEqual({ idle: true, reasons: [] })
    f.agent.inject(message())
    vi.mocked(f.calls.harness).mockResolvedValue({ busy: true })
    vi.mocked(f.calls.feedbackTasks).mockResolvedValue([{ state: 'accepted' }])
    const gate = new UpdateAdmission()
    const barrier = deferred<void>()
    const pending = gate.admit(() => barrier.promise)
    expect(await inspectUpdateActivity(f.ctx, f.calls, gate)).toEqual({
      idle: false,
      reasons: ['queue', 'admission', 'harness', 'feedback'],
    })
    barrier.resolve()
    await pending
  })

  it('propagates activity read failures and resamples a native wake during an asynchronous owner read', async () => {
    const f = activityFixture()
    const barrier = deferred<{ busy: boolean }>()
    vi.mocked(f.calls.harness).mockReturnValue(barrier.promise)
    const entered = deferred<void>()
    vi.mocked(f.calls.harness).mockImplementation(() => {
      entered.resolve()
      return barrier.promise
    })
    const inspection = inspectUpdateActivity(f.ctx, f.calls)
    await entered.promise
    f.agent.followup(message())
    barrier.resolve({ busy: false })
    expect(await inspection).toEqual({ idle: false, reasons: ['agent', 'queue'] })
    const failure = Error('activity unavailable')
    vi.mocked(f.calls.harness).mockRejectedValue(failure)
    await expect(inspectUpdateActivity(f.ctx, f.calls)).rejects.toBe(failure)
  })
})
