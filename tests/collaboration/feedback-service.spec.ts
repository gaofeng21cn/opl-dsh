import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage, { type KvUnit, type StorageBackend } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TaskFeedbackService from '../../src/collaboration/host/feedback/index.ts'
import { feedbackSessionFacts } from '../../src/collaboration/host/feedback/session-facts.ts'
import type { WakeDelivery } from '../../src/collaboration/host/feedback/types.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  while (cleanups.length) await cleanups.pop()!()
})

/** Only the opaque media seam is substituted: real DomainFacility validates
 * reloads and updates its memory after successful writes, under its own queue.
 * The file is reread on every mount; no service/domain state survives restart.
 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'opl-feedback-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  let failTable: string | undefined
  const file = join(root, 'domain.json')
  const backend: StorageBackend = {
    close: async () => {},
    kv: {
      async open(descriptor) {
        let data: Awaited<ReturnType<KvUnit['loadAll']>>
        try {
          data = JSON.parse(await readFile(file, 'utf8'))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          data = {
            tables: Object.fromEntries(descriptor.tables.map((name) => [name, {}])),
            global: null,
          }
        }
        let closed = false
        async function persist(next: typeof data, table: string) {
          if (closed) throw new Error('closed')
          if (failTable === table) {
            failTable = undefined
            throw new Error(`injected ${table} write failure`)
          }
          await writeFile(file + '.tmp', JSON.stringify(next))
          await rename(file + '.tmp', file)
          data = next
        }
        return {
          loadAll: async () => structuredClone(data),
          putRecord: async (table, key, value) => {
            await persist(
              {
                ...data,
                tables: { ...data.tables, [table]: { ...data.tables[table], [key]: value } },
              },
              table,
            )
          },
          deleteRecord: async (table, key) => {
            const records = { ...data.tables[table] }
            delete records[key]
            await persist({ ...data, tables: { ...data.tables, [table]: records } }, table)
          },
          setGlobal: async (global) => {
            await persist({ ...data, global }, 'global')
          },
          close: async () => {
            closed = true
          },
        }
      },
    },
  }
  async function mount(autoDeliver = false) {
    const ctx = new Context()
    await ctx.plugin(Storage)
    ctx.storage.backend.register('fixture', backend)
    ctx.provide('storageDomain')
    ctx.set('storageDomain', new DomainFacility(ctx, { backend: 'fixture' }))
    const session = { id: 'source-session' as SessionId, seq: 0 } as Session
    ctx.provide('sessions')
    ctx.set('sessions', {
      get: (id: SessionId) => (id === session.id ? session : undefined),
    } as Context['sessions'])
    let facts = feedbackSessionFacts.init()
    ctx.provide('sessionProjections')
    ctx.set('sessionProjections', {
      register: () => {},
      stateOf: (_session: Session, key: string) =>
        key === 'taskFeedbackFacts'
          ? facts
          : key === 'turnBoundary'
            ? {
                lastTurn: facts.openTurn ?? 1,
                openTurnStartSeq: facts.openTurn === null ? null : 1,
              }
            : undefined,
    } as unknown as Context['sessionProjections'])
    await ctx.plugin(TaskFeedbackService, { autoDeliver, claimLeaseMs: 10_000, retryBaseMs: 1 })
    cleanups.push(() => ctx.fiber.dispose())
    const service = ctx.taskFeedback
    async function complete(taskId = 'task') {
      await service.register({
        taskId,
        sessionId: session.id,
        turn: 1,
        target: { kind: 'codex-thread', threadId: 'target-thread' },
        acceptance: 'verified outcome',
      })
      const event = {
        type: 'turn/end',
        seq: 1,
        data: { turn: 1, reason: { kind: 'completed' } },
      } as SessionEvent
      facts = feedbackSessionFacts.apply(facts, event)
      ctx.emit('session/event', session, event)
      await service.settled()
      return service.deliveries()[0]!
    }
    async function emit(event: SessionEvent) {
      facts = feedbackSessionFacts.apply(facts, event)
      session.seq = event.seq
      ctx.emit('session/event', session, event)
      await service.settled()
    }
    async function start(taskId = 'task') {
      await service.register({
        taskId,
        sessionId: session.id,
        turn: 1,
        target: { kind: 'codex-thread', threadId: 'target-thread' },
        acceptance: 'verified outcome',
      })
      await emit({ type: 'turn/start', seq: 1, data: { turn: 1 } } as SessionEvent)
    }
    return { ctx, service, complete, emit, start }
  }
  return {
    mount,
    failNext: (table: string) => {
      failTable = table
    },
  }
}

const accepting = () => ({
  id: 'test-transport',
  probe: async () => ({ started: true, detail: 'test' }),
  send: vi.fn(async (_delivery: WakeDelivery) => ({ accepted: true })),
})

describe('feedback service durable lifecycle', () => {
  it('withdraws an obsolete combination pause without dropping its completion', async () => {
    const first = await (await fixture()).mount()
    const { task } = await first.service.registerHarnessOperation({
      execution: {
        kind: 'harness-session',
        harnessSessionId: 'harness-test',
        harnessRef: 'minimax-code',
        combination: 'minimax-code/M3.1',
        taskId: 'external',
        operationId: 'initial',
      },
      target: { kind: 'codex-thread', threadId: 'target-thread' },
      acceptance: 'verified outcome',
    })
    await first.service.reportHarnessState({
      taskId: task.taskId,
      state: 'waiting_approval',
      summary: 'pending',
      pause: {
        kind: 'approval',
        pauseId: 'approval:a',
        approval: { approvalId: 'a', toolName: 'Bash' },
      },
    })
    await first.service.reportHarnessState({
      taskId: task.taskId,
      state: 'completed',
      summary: 'done',
    })
    const transport = accepting()
    first.service.setWakeAdapter(transport)
    await first.service.flush()
    expect(transport.send).toHaveBeenCalledOnce()
    expect(transport.send.mock.calls[0]?.[0].deliveryId).toBe(task.taskId + '@completed')
    expect(first.service.deliveries().find((x) => x.payload.needsInput !== null)?.retired).toBe(
      true,
    )
  })

  it('does not retire a transport-owned pause when another flush observes resolution', async () => {
    const first = await (await fixture()).mount()
    await first.start()
    await first.emit({
      type: 'approval/asked',
      seq: 2,
      data: { id: 'a', toolName: 'Bash' },
    } as SessionEvent)
    const entered = Promise.withResolvers<void>(),
      result = Promise.withResolvers<{ accepted: boolean }>()
    const transport = accepting()
    transport.send.mockImplementationOnce(async () => {
      entered.resolve()
      return result.promise
    })
    first.service.setWakeAdapter(transport)
    const flush = first.service.flush()
    await entered.promise
    await first.emit({
      type: 'approval/decided',
      seq: 3,
      data: { id: 'a', outcome: 'allowed-once' },
    } as SessionEvent)
    const again = first.service.flush()
    result.resolve({ accepted: true })
    await Promise.all([flush, again])
    expect(first.service.deliveries()[0]).toMatchObject({ retired: false, stage: 'delivered' })
    expect(transport.send).toHaveBeenCalledOnce()
  })

  it('skips an acknowledgment received while an earlier delivery is in flight', async () => {
    const first = await (await fixture()).mount()
    await first.complete('first')
    await first.complete('second')
    const entered = Promise.withResolvers<void>()
    const result = Promise.withResolvers<{ accepted: boolean }>()
    const transport = accepting()
    transport.send.mockImplementationOnce(async () => {
      entered.resolve()
      return result.promise
    })
    first.service.setWakeAdapter(transport)
    const flush = first.service.flush()
    await entered.promise
    const claim = await first.service.receive({
      taskId: 'second',
      deliveryId: 'second@completed',
      consumerId: 'reviewer',
    })
    await first.service.consume({
      taskId: 'second',
      deliveryId: 'second@completed',
      consumerId: 'reviewer',
      claimEpoch: claim.receipt.claimEpoch,
    })
    result.resolve({ accepted: true })
    await flush
    expect(transport.send).toHaveBeenCalledOnce()
  })

  it('retires only the decided approval and keeps other simultaneous approvals deliverable', async () => {
    const first = await (await fixture()).mount()
    await first.start()
    await first.emit({
      type: 'approval/asked',
      seq: 2,
      data: { id: 'a', toolName: 'Bash' },
    } as SessionEvent)
    await first.emit({
      type: 'approval/asked',
      seq: 3,
      data: { id: 'b', toolName: 'Read' },
    } as SessionEvent)
    await first.emit({
      type: 'approval/decided',
      seq: 4,
      data: { id: 'a', outcome: 'allowed-once' },
    } as SessionEvent)
    const transport = accepting()
    first.service.setWakeAdapter(transport)
    await first.service.flush()
    expect(transport.send).toHaveBeenCalledOnce()
    expect(transport.send.mock.calls[0]?.[0]).toMatchObject({
      deliveryId: 'task@waiting_approval@3',
    })
    expect(
      first.service.deliveries().find((x) => x.deliveryId === 'task@waiting_approval@2'),
    ).toMatchObject({ retired: true, attempts: 0 })
  })

  it('retires unsent pauses after completion and preserves retirement across restart', async () => {
    const disk = await fixture(),
      first = await disk.mount()
    await first.start()
    await first.emit({
      type: 'approval/asked',
      seq: 2,
      data: { id: 'a', toolName: 'Bash' },
    } as SessionEvent)
    await first.emit({
      type: 'turn/end',
      seq: 3,
      data: { turn: 1, reason: { kind: 'completed' } },
    } as SessionEvent)
    const transport = accepting()
    first.service.setWakeAdapter(transport)
    await first.service.flush()
    expect(transport.send).toHaveBeenCalledOnce()
    expect(transport.send.mock.calls[0]?.[0]).toMatchObject({ deliveryId: 'task@completed' })
    await first.ctx.fiber.dispose()
    const restarted = await disk.mount()
    restarted.service.setWakeAdapter(transport)
    expect(await restarted.service.flush()).toMatchObject({ attempted: 0 })
    expect(
      restarted.service.deliveries().find((x) => x.payload.state === 'waiting_approval')?.retired,
    ).toBe(true)
  })

  it('keeps an accepted pause claimable after it resolves', async () => {
    const first = await (await fixture()).mount()
    await first.start()
    await first.emit({
      type: 'approval/asked',
      seq: 2,
      data: { id: 'a', toolName: 'Bash' },
    } as SessionEvent)
    first.service.setWakeAdapter(accepting())
    await first.service.flush()
    await first.emit({
      type: 'approval/decided',
      seq: 3,
      data: { id: 'a', outcome: 'allowed-once' },
    } as SessionEvent)
    await first.service.flush()
    expect(
      await first.service.receive({
        taskId: 'task',
        deliveryId: 'task@waiting_approval@2',
        consumerId: 'reviewer',
      }),
    ).toMatchObject({ action: 'review', delivery: { retired: false } })
  })

  it('repairs the task/outbox split write on restart without registering or executing work again', async () => {
    const disk = await fixture(),
      first = await disk.mount()
    disk.failNext('outbox')
    await expect(first.complete()).rejects.toThrow('injected outbox')
    expect(first.service.deliveries()).toEqual([])
    await first.ctx.fiber.dispose()
    const restarted = await disk.mount()
    expect(restarted.service.tasks()).toMatchObject([{ taskId: 'task', state: 'completed' }])
    expect(restarted.service.deliveries()).toMatchObject([
      { deliveryId: 'task@completed', stage: 'enqueued' },
    ])
    const transport = accepting()
    restarted.service.setWakeAdapter(transport)
    await restarted.service.flush()
    expect(transport.send).toHaveBeenCalledOnce()
  })

  it('serializes concurrent flushes and never resends an accepted handoff after restart', async () => {
    const disk = await fixture(),
      first = await disk.mount()
    await first.complete()
    const transport = accepting()
    first.service.setWakeAdapter(transport)
    await Promise.all([first.service.flush(), first.service.flush()])
    expect(transport.send).toHaveBeenCalledOnce()
    expect(first.service.deliveries()[0]).toMatchObject({
      stage: 'delivered',
      attempts: 1,
      acknowledged: false,
    })
    await first.ctx.fiber.dispose()
    const restarted = await disk.mount()
    restarted.service.setWakeAdapter(transport)
    expect(await restarted.service.flush()).toMatchObject({ attempted: 0, pending: 1 })
    expect(transport.send).toHaveBeenCalledOnce()
  })

  it('does not acknowledge a failed receipt write, and recovers a claim whose acknowledgment failed', async () => {
    const disk = await fixture(),
      first = await disk.mount()
    const delivery = await first.complete()
    const request = {
      taskId: delivery.taskId,
      deliveryId: delivery.deliveryId,
      consumerId: 'reviewer',
    }
    disk.failNext('receipts')
    await expect(first.service.receive(request)).rejects.toThrow('injected receipts')
    expect(first.service.receipts()).toEqual([])
    expect(first.service.deliveries()[0]?.acknowledged).toBe(false)
    disk.failNext('outbox')
    await expect(first.service.receive(request)).rejects.toThrow('injected outbox')
    expect(first.service.receipts()).toMatchObject([{ ownerId: 'reviewer', claimEpoch: 1 }])
    await first.ctx.fiber.dispose()
    const restarted = await disk.mount()
    expect(await restarted.service.receive(request)).toMatchObject({
      action: 'resume',
      receipt: { claimEpoch: 1 },
      delivery: { acknowledged: true },
    })
    expect(await restarted.service.receive({ ...request, consumerId: 'other' })).toMatchObject({
      action: 'busy',
    })
  })

  it('rejects a superseded consumer and persists consumption so duplicate notifications skip review', async () => {
    const disk = await fixture(),
      first = await disk.mount()
    await first.complete()
    const request = { taskId: 'task', deliveryId: 'task@completed' }
    const received = await first.service.receive({ ...request, consumerId: 'first' })
    const future = Date.parse(received.receipt.leaseExpiresAt!) + 1
    vi.spyOn(Date, 'now').mockReturnValue(future)
    const reclaimed = await first.service.receive({ ...request, consumerId: 'second' })
    expect(reclaimed).toMatchObject({
      action: 'resume',
      receipt: { claimEpoch: 2, ownerId: 'second' },
    })
    await expect(
      first.service.consume({ ...request, consumerId: 'first', claimEpoch: 1 }),
    ).rejects.toMatchObject({ code: 'task-feedback/stale-claim' })
    disk.failNext('receipts')
    await expect(
      first.service.consume({ ...request, consumerId: 'second', claimEpoch: 2 }),
    ).rejects.toThrow('injected receipts')
    expect(first.service.receipts()[0]?.status).toBe('received')
    await first.service.consume({ ...request, consumerId: 'second', claimEpoch: 2 })
    await first.ctx.fiber.dispose()
    const restarted = await disk.mount()
    expect(await restarted.service.receive({ ...request, consumerId: 'third' })).toMatchObject({
      action: 'skip',
      receipt: { status: 'consumed', claimEpoch: 2 },
    })
  })

  it('keeps a receiver acknowledgment that lands while the transport is still returning', async () => {
    const disk = await fixture(),
      first = await disk.mount()
    await first.complete()
    const entered = Promise.withResolvers<void>()
    const result = Promise.withResolvers<{ accepted: boolean }>()
    const transport = accepting()
    transport.send.mockImplementationOnce(async () => {
      entered.resolve()
      return result.promise
    })
    first.service.setWakeAdapter(transport)
    const flush = first.service.flush()
    await entered.promise
    await first.service.receive({
      taskId: 'task',
      deliveryId: 'task@completed',
      consumerId: 'receiver',
    })
    result.resolve({ accepted: true })
    await flush
    expect(first.service.deliveries()[0]).toMatchObject({
      stage: 'received',
      acknowledged: true,
      attempts: 1,
      nextAttemptAt: null,
    })
  })

  it('starts the automatic pump and aborts a hanging send before closing the domain', async () => {
    const disk = await fixture(),
      first = await disk.mount(true)
    const entered = Promise.withResolvers<AbortSignal>()
    first.service.setWakeAdapter({
      ...accepting(),
      send: async (_delivery, signal) => {
        entered.resolve(signal)
        return new Promise(() => {})
      },
    })
    await first.complete()
    const signal = await entered.promise
    await first.ctx.fiber.dispose()
    expect(signal.aborted).toBe(true)
    const restarted = await disk.mount()
    expect(restarted.service.deliveries()[0]).toMatchObject({
      stage: 'enqueued',
      attempts: 0,
      acknowledged: false,
    })
  })

  it('retries refused transport without changing the completed task', async () => {
    const disk = await fixture(),
      first = await disk.mount()
    await first.complete()
    const transport = accepting()
    transport.send.mockResolvedValueOnce({ accepted: false })
    first.service.setWakeAdapter(transport)
    expect(await first.service.flush()).toMatchObject({ attempted: 1, delivered: 0, pending: 1 })
    expect(first.service.task({ taskId: 'task' }).state).toBe('completed')
    vi.spyOn(Date, 'now').mockReturnValue(
      Date.parse(first.service.deliveries()[0]!.nextAttemptAt!) + 1,
    )
    expect(await first.service.flush()).toMatchObject({ attempted: 1, delivered: 1 })
    expect(transport.send).toHaveBeenCalledTimes(2)
  })
})
