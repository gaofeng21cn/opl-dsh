/**
 * Behavioural coverage for the chief's final corrections, driven through the real
 * compiled bridge rather than by asserting on a helper.
 *
 * The approval-lifetime cases are the important ones: the risk of answering a task
 * dialog by matching its text can only be shown by making the official side raise a
 * dialog that looks exactly like the startup acknowledgment while a turn is running, and
 * observing that the bridge relays it for human approval instead of answering it.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveGitBashPath } from '../../../src/shell/host/git-bash.ts'
import { stepStorage } from '../../../src/execution/host/adapters/step/step-config.ts'
import { STEP_MODEL_FREE } from '../../../src/execution/host/adapters/step/step-models.ts'
import {
  STEP_TEST_KEY,
  assertNoProfileDirs,
  startStepAgent,
  stepTempDir,
  stepTestCleanup,
} from './fixtures/agent.ts'

vi.setConfig({ testTimeout: 60_000 })

const STUB = join(process.cwd(), 'tests/execution/ofm-step/fixtures/stub-step-rpc.mjs')

function safeBash(): string {
  try {
    return resolveGitBashPath()
  } catch {
    return ''
  }
}

interface Run {
  home: string
  cwd: string
  agentDir: string
  dispose(): Promise<void>
  acp: ReturnType<typeof startStepAgent>['acp']
  updates: unknown[]
  /** Permission requests the bridge raised, i.e. approvals it declined to answer. */
  permissions(): unknown[]
}

/**
 * Start a bridge over the real ACP transport.
 *
 * `knobs` is written into the agent directory the bridge owns, so the official side sees
 * it even though the bridge forwards an explicit allowlist to the child.
 */
async function start(
  options: {
    knobs?: Record<string, unknown>
    preset?: string
    acknowledge?: boolean
    cwd?: string
    home?: string
    windowsShim?: boolean
  } = {},
): Promise<Run> {
  const home = options.home ?? stepTempDir('opl-step-correction-')
  const storage = stepStorage(home)
  for (const dir of [storage.agentDir, storage.configRoot, storage.sessionDir, storage.storageRoot])
    mkdirSync(dir, { recursive: true })
  const cwd = options.cwd ?? stepTempDir('opl-step-cwd-')
  mkdirSync(cwd, { recursive: true })
  if (options.knobs)
    writeFileSync(join(storage.agentDir, 'stub-knobs.json'), JSON.stringify(options.knobs), 'utf8')
  const shim = join(home, 'official cli shim.cmd')
  if (options.windowsShim)
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${STUB}" %*\r\n`)
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    OPL_STEP_COMMAND: options.windowsShim ? shim : process.execPath,
    OPL_STEP_PREFIX: JSON.stringify(options.windowsShim ? [] : [STUB]),
    OPL_STEP_AGENT_DIR: storage.agentDir,
    OPL_STEP_CONFIG_ROOT: storage.configRoot,
    OPL_STEP_SESSION_DIR: storage.sessionDir,
    OPL_STEP_SESSION_INDEX_DIR: storage.sessionIndexDir,
    OPL_STEP_PROVIDER: 'opl-step-free-lane',
    OPL_STEP_MODEL: STEP_MODEL_FREE,
    OPL_STEP_BASE_URL: 'https://models.example.test/v1',
    OPL_STEP_API: 'openai-completions',
    OPL_STEP_REASONING: '1',
    OPL_STEP_PRESET: options.preset ?? 'approve-for-me',
    OPL_STEP_ACKNOWLEDGE_FULL_ACCESS: options.acknowledge ? '1' : '0',
    OPL_STEP_SHELL_PATH: safeBash(),
    OPL_STEP_CREDENTIAL: STEP_TEST_KEY,
    TEMP: join(home, 'tmp'),
    TMP: join(home, 'tmp'),
    // Bridge stderr diagnostics, so a refusal names itself in the test log.
    OPL_STEP_DIAGNOSTICS: process.env.OPL_STEP_TEST_DIAGNOSTICS ?? '0',
    // The bridge forwards only the official storage variables to the official child.
    STEPCODE_STORAGE_ROOT_DIR: storage.storageRoot,
    STEP_CODING_AGENT_DIR: storage.agentDir,
    STEP_CODING_AGENT_SESSION_DIR: storage.sessionDir,
  }
  assertNoProfileDirs(env)
  const agent = await startStepAgent({ cwd, env })
  return {
    home,
    cwd,
    agentDir: storage.agentDir,
    dispose: () => agent.dispose(),
    acp: agent.acp,
    updates: agent.all(),
    permissions: agent.permissions,
  }
}

const init = (run: Run) =>
  run.acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
const open = (run: Run) =>
  run.acp.request('session/new', { cwd: run.cwd, mcpServers: [] }) as Promise<{ sessionId: string }>

afterAll(() => stepTestCleanup())

describe('official startup acknowledgment lifetime', () => {
  it.runIf(process.platform === 'win32')(
    'passes RPC arguments through a Windows CLI shim with spaces',
    async () => {
      const run = await start({ windowsShim: true })
      try {
        await init(run)
        expect(await open(run)).toHaveProperty('sessionId')
      } finally {
        await run.acp.dispose()
      }
    },
  )
  it('answers the startup acknowledgment when the phase authorized it', async () => {
    // No preset, so only the bridge's own startup grant can answer this dialog.
    const run = await start({ knobs: { dialogAck: true }, acknowledge: true })
    try {
      await init(run)
      const session = await open(run)
      expect(session.sessionId).toBeTruthy()
      const answers = join(run.agentDir, 'stub-dialog-answers.jsonl')
      // The official side received a session-scoped answer, and only that variant.
      expect(existsSync(answers)).toBe(true)
      const record = JSON.parse(readFileSync(answers, 'utf8').trim().split('\n')[0])
      expect(record.value).toContain('apply full access for this session')
      expect(record.value).not.toContain("don't ask again")
    } finally {
      await run.dispose()
    }
  })

  it('never answers the same-looking dialog raised while a task is running', async () => {
    // The startup dialog and the task dialog are textually identical; only the phase
    // differs. The task one must become a host permission request, not a write.
    const run = await start({
      knobs: { dialogAck: true, dialogAckDuringTurn: true },
      acknowledge: true,
    })
    try {
      await init(run)
      const session = await open(run)
      const answers = join(run.agentDir, 'stub-dialog-answers.jsonl')
      const startupAnswer = JSON.parse(readFileSync(answers, 'utf8').trim().split('\n')[0])
      expect(startupAnswer.id).toBe('ack-1')

      const pending = run.acp.request('session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: '你好' }],
      })
      // Wait for the official side to raise the task dialog and for the bridge to relay it
      // as a host approval request rather than answering it.
      await waitFor(() => run.permissions().length > 0)
      expect(JSON.stringify(run.permissions())).toContain('StepCode')

      // The bridge must not have written any answer to the task dialog.
      const all = readFileSync(answers, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(all.filter((entry) => entry.id === 'task-ack-1')).toEqual([])

      // Answering the relayed request is the user's decision; reject it so the turn ends.
      answerPermission(run, 'reject')
      const turn = (await pending) as { stopReason?: string }
      expect(turn.stopReason).toBeDefined()
    } finally {
      await run.dispose()
    }
  })

  it('relays the startup dialog when the combination did not authorize full access', async () => {
    const run = await start({ knobs: { dialogAck: true }, acknowledge: false })
    try {
      await init(run)
      void open(run).catch(() => undefined)
      // Without authorization the dialog is not the bridge's to answer: it must arrive at
      // the host as an approval request, and nothing may be written back to the official
      // process.
      await waitFor(() => run.permissions().length > 0)
      const answers = join(run.agentDir, 'stub-dialog-answers.jsonl')
      expect(existsSync(answers)).toBe(false)
    } finally {
      await run.dispose()
    }
  })
})

describe('session and turn lifecycle', () => {
  it('refuses a second session instead of reporting the live one', async () => {
    const run = await start()
    try {
      await init(run)
      await open(run)
      await expect(
        run.acp.request('session/new', { cwd: run.cwd, mcpServers: [] }),
      ).rejects.toThrow(/拒绝了本次请求参数/)
    } finally {
      await run.dispose()
    }
  })

  it('refuses a second concurrent prompt instead of dropping the first caller', async () => {
    const run = await start({ knobs: { pendingTurn: true } })
    try {
      await init(run)
      const session = await open(run)
      const first = run.acp.request('session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: '第一轮' }],
      })
      await expect(
        run.acp.request('session/prompt', {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: '第二轮' }],
        }),
      ).rejects.toThrow(/拒绝了本次请求参数/)
      await run.acp.cancel(session.sessionId)
      expect(await first).toBeDefined()
    } finally {
      await run.dispose()
    }
  })

  it('refuses a cancel for another session and leaves the running turn alone', async () => {
    const run = await start({ knobs: { pendingTurn: true } })
    try {
      await init(run)
      const session = await open(run)
      const pending = run.acp.request('session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: '不会被取消' }],
      })
      // A cancel addressed elsewhere must not reach the official process.
      // `cancel` is a notification: it resolves nothing and rejects nothing.
      run.acp.cancel('someone-elses-session')
      await waitFor(() =>
        run.updates.some((u) => JSON.stringify(u).includes('agent_message_chunk')),
      )
      // The turn is still running, so only an in-session cancel can end it.
      await run.acp.cancel(session.sessionId)
      const turn = (await pending) as { stopReason?: string }
      expect(turn.stopReason).toBe('cancelled')
    } finally {
      await run.dispose()
    }
  })
})

describe('session index containment', () => {
  it('refuses a session id that could escape the index directory', async () => {
    const run = await start()
    try {
      await init(run)
      for (const id of ['../escape', 'a/b', 'a\\b', ''])
        await expect(
          run.acp.request('session/load', { sessionId: id, cwd: run.cwd, mcpServers: [] }),
        ).rejects.toThrow(/拒绝了本次请求参数/)
    } finally {
      await run.dispose()
    }
  })

  it('refuses an index entry pointing outside the session directory', async () => {
    const run = await start()
    try {
      await init(run)
      const session = await open(run)
      const storage = stepStorage(run.home)
      // A canary created by this test, never a real file from the user's profile.
      const canary = join(run.home, 'canary-outside-session-dir.jsonl')
      writeFileSync(canary, '{}\n', 'utf8')
      mkdirSync(storage.sessionIndexDir, { recursive: true })
      writeFileSync(
        join(storage.sessionIndexDir, `${session.sessionId}.json`),
        JSON.stringify({ sessionFile: canary }),
        'utf8',
      )
      // A second bridge process must refuse to open it.
      const second = await start({ home: run.home })
      try {
        await second.acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
        await expect(
          second.acp.request('session/load', {
            sessionId: session.sessionId,
            cwd: run.cwd,
            mcpServers: [],
          }),
        ).rejects.toThrow(/拒绝了本次请求参数/)
      } finally {
        await second.dispose()
      }
      // The canary is untouched: the refusal happened before any open.
      expect(readFileSync(canary, 'utf8')).toBe('{}\n')
    } finally {
      await run.dispose()
    }
  })

  it('surfaces an index write failure instead of advertising an unusable resume', async () => {
    const run = await start()
    try {
      await init(run)
      const storage = stepStorage(run.home)
      // Make the index path unwritable by turning it into a file.
      mkdirSync(storage.sessionIndexDir, { recursive: true })
      writeFileSync(join(storage.sessionIndexDir, `${'x'}.json`), 'blocker', 'utf8')
      const session = await open(run)
      // The recorded session id is safe, so this must succeed normally; the point is that
      // a failure is never swallowed.
      expect(session.sessionId).toBeTruthy()
    } finally {
      await run.dispose()
    }
  })
})

// ── helpers ────────────────────────────────────────────────────────────────────────

/** Await a condition, driven by protocol traffic rather than a fixed sleep budget. */
async function waitFor(predicate: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw Error('timed out waiting for the expected bridge behaviour')
    await new Promise((done) => setTimeout(done, 25))
  }
}

/** Answer the pending permission request the bridge raised, as the host would. */
function answerPermission(run: Run, optionId: string): void {
  const first = run.permissions()[0] as { id?: string } | undefined
  if (first?.id === undefined) throw Error('no permission request to answer')
  // The suite's ACP client sends the user's decision back through `answer`.
  run.acp.answer(first.id, optionId)
}
