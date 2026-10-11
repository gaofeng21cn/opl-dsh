/**
 * 普通发模型入口与委派入口对“结果不确定的编辑”的拒绝。
 *
 * 只落两条真实的持久记录（会话记录 + 编辑意图台账），再启动真实的 HarnessService：
 * 被卡住的会话必须在拉起子进程之前就被拒绝，因此这里既不发模型请求，也不启动任何
 * Harness 进程，更不读取任何真实用户配置或凭据。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { HarnessService } from '../../src/execution/host/harness.ts'
import type { StopEditIntent } from '../../src/execution/contracts/stop-edit.ts'

const cleanups: (() => Promise<unknown>)[] = []
/** Windows 可能仍持有刚释放的目录句柄。 */
const removeTree = (path: string) =>
  rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

const SESSION_ID = 'session-blocked'

function intent(phase: StopEditIntent['phase']): StopEditIntent {
  const at = '2026-10-10T00:00:00.000Z'
  return {
    sessionId: SESSION_ID,
    clientRequestId: 'r1',
    boundaryId: 'dsh:3',
    preservedSessionId: SESSION_ID,
    pendingOperationId: 'op-new',
    pendingDraft: '第二条',
    phase,
    ...(phase === 'uncertain' ? { reason: '投影或结果落盘失败，请先核对会话历史' } : {}),
    at,
    updatedAt: at,
  }
}

/**
 * 落盘一个真实的组合会话与一条真实台账，然后构造真实的 HarnessService。
 *
 * `command` 指向 Node 自身且不带任何脚本：万一准入检查失效，连接必然失败而不是真的
 * 启动某个 Harness，测试仍然会失败，但不会碰到任何外部进程或凭据。
 */
async function service(
  phase: StopEditIntent['phase'],
  ordinary?: {
    session: unknown
    agent: unknown
  },
) {
  const root = (await mkdtemp(join(tmpdir(), 'opl-stop-edit-'))).replace(/\\/g, '/')
  cleanups.push(() => removeTree(root))
  const home = join(root, 'state')
  const sessions = join(home, 'profiles/desktop/harness-sessions')
  const intents = join(home, 'profiles/desktop/stop-edit-intents')
  await mkdir(sessions, { recursive: true, mode: 0o700 })
  await mkdir(intents, { recursive: true, mode: 0o700 })
  const record = {
    id: 'harness-1',
    combination: 'dsh/deepseek-flash',
    harnessRef: 'dsh',
    modelRef: { provider: 'deepseek', model: 'deepseek-flash' },
    cwd: root,
    acpSessionId: SESSION_ID,
    title: '组合',
    sandbox: 'workspace',
    origin: { kind: 'codex', sessionId: 'parent' },
    createdAt: '2026-10-10T00:00:00.000Z',
    updatedAt: '2026-10-10T00:00:00.000Z',
    turns: [],
  }
  if (!ordinary)
    await writeFile(
      join(sessions, createHash('sha256').update('harness-1').digest('hex') + '.json'),
      JSON.stringify(record),
      { mode: 0o600 },
    )
  await writeFile(
    join(intents, createHash('sha256').update(SESSION_ID).digest('hex') + '.json'),
    JSON.stringify(intent(phase)),
    { mode: 0o600 },
  )
  const ctx = {
    get: () => undefined,
    agents: { get: () => ordinary?.agent },
    logger: { warn: () => {} },
    sessions: { get: () => ordinary?.session },
    sessionProjections: {
      snapshot: () => ({
        values: {
          modelSelection: {
            next: { provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'high' },
          },
        },
      }),
    },
  } as unknown as Context
  const harness = new HarnessService(ctx, { home, command: process.execPath })
  cleanups.push(() => harness.dispose())
  return harness
}

describe('普通发模型与委派入口：结果不确定的会话一律拒绝', () => {
  it('没有组合记录的普通 DSH 请求也受重启后的不确定状态阻断', async () => {
    const harness = await service('rewinding', { session: undefined, agent: undefined })
    await expect(harness.assertConversationEditable(SESSION_ID)).rejects.toThrow('改动途中中断')
  })

  it('普通 DSH 编辑先清除运行与排队工作，再等待真正空闲', async () => {
    const calls: string[] = []
    const agent = {
      status: 'running',
      cancel: (cause: unknown, options?: unknown) => {
        expect(cause).toEqual({ kind: 'user' })
        expect(options).toBeUndefined()
        calls.push('cancel')
        agent.status = 'idle'
      },
      whenIdle: async () => {
        calls.push('idle')
      },
    }
    const harness = await service('planned', {
      agent,
      session: { header: {}, snapshotEvents: () => [] },
    })
    await expect(
      harness.stopEdit({ sessionId: SESSION_ID, clientRequestId: 'r2', boundaryId: 'missing' }),
    ).rejects.toThrow('stale-history')
    expect(calls).toEqual(['cancel', 'idle'])
  })

  it('uncertain 会话在普通发模型前被拒绝，而不是带着未知上下文继续', async () => {
    const harness = await service('uncertain')
    await expect(
      harness.prompt({ sessionId: 'harness-1', text: '继续做下一步', operationId: 'op-1' }),
    ).rejects.toThrow('投影或结果落盘失败，请先核对会话历史')
  })

  it('重启后停在 rewinding 的会话同样被拒绝：改动可能已经发出', async () => {
    const harness = await service('rewinding')
    await expect(
      harness.prompt({ sessionId: 'harness-1', text: '继续做下一步', operationId: 'op-1' }),
    ).rejects.toThrow('上一次停止后编辑在改动途中中断')
  })

  it('委派到被卡住的会话在启动子会话之前就被拒绝', async () => {
    const harness = await service('uncertain')
    await expect(
      harness.delegateFrom(
        { kind: 'codex', sessionId: 'parent' },
        {
          sessionId: 'harness-1',
          task: '继续做下一步',
          taskId: 'task-1',
          operationId: 'op-1',
        },
      ),
    ).rejects.toThrow('投影或结果落盘失败，请先核对会话历史')
  })

  it('planned 阶段不算阻断：Runtime 还没被调用过，会话没有被改动', async () => {
    const harness = await service('planned')
    // 不去断言连接结果（那属于启动路径），只断言准入检查本身没有拦下这次发送。
    const failed = await harness
      .prompt({ sessionId: 'harness-1', text: '继续做下一步', operationId: 'op-1' })
      .then(() => undefined)
      .catch((error: Error) => error.message)
    expect(failed ?? '').not.toContain('停止后编辑')
  })

  it('uncertain 会话的停止后编辑请求在真实 Host 上被拒绝，不会重发一次回退', async () => {
    const harness = await service('uncertain')
    // 身份换成新的也一样：阻断先于任何回退动作，Runtime 根本不会被调用。
    await expect(
      harness.stopEdit({
        sessionId: SESSION_ID,
        clientRequestId: 'r-new',
        boundaryId: 'dsh:3',
      }),
    ).rejects.toThrow('停止后编辑被拒绝（uncertain）')
  })

  it('入口状态在真实 Host 上给出可解释的阻断：harness、pending 与固定原因', async () => {
    const harness = await service('uncertain')
    const state = await harness.stopEditState({ sessionId: SESSION_ID })
    expect(state).toMatchObject({
      supported: false,
      harness: 'dsh',
      pending: true,
      boundaries: [],
    })
    expect(state.reason).toBe('投影或结果落盘失败，请先核对会话历史')
  })
})
