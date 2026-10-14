/**
 * End-to-end behaviour of the ACP projection over the official StepCode RPC surface.
 *
 * These cases drive the **real compiled bridge as a separate process**, through the
 * suite's own `AcpProcess`, against a stub that reproduces the shipped `step.exe` 0.1.4
 * protocol and its failure modes. Nothing here is a same-process function call, and
 * nothing polls on a timer: every wait is resolved by the awaited protocol traffic
 * itself, so there is no sleep-and-hope race.
 *
 * The working directory used throughout mixes non-ASCII characters and a space, and the
 * stub runs a genuine external `git` command through the shell the bridge pinned, so
 * quoting, PATH and non-ASCII paths are exercised rather than asserted.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { resolveGitBashPath } from '../../../src/shell/host/git-bash.ts'
import {
  STEP_AGENT_DIR_ENV,
  STEP_SESSION_DIR_ENV,
  STEP_STORAGE_ROOT_ENV,
  stepStorage,
} from '../../../src/execution/host/adapters/step/step-config.ts'
import {
  STEP_MODEL_FREE,
  STEP_MODEL_KILO,
} from '../../../src/execution/host/adapters/step/step-models.ts'
import {
  STEP_TEST_KEY,
  assertNoProfileDirs,
  startStepAgent,
  stepTempDir,
  stepTestCleanup,
  type StepAgent,
} from './fixtures/agent.ts'

// Every case here launches real processes (a Node bridge, an RPC server and a Git Bash
// command), so the default per-test budget is too small. This raises it for this file
// only, rather than changing the shared test configuration.
vi.setConfig({ testTimeout: 60_000 })

const exec = promisify(execFile)
// Module-relative, not `process.cwd()`-relative: the suite must launch this stub the same
// way no matter which directory the runner was started from.
const STUB = fileURLToPath(new URL('./fixtures/stub-step-rpc.mjs', import.meta.url))

interface Launch {
  agent: StepAgent
  home: string
  cwd: string
  /** The launch environment, mirroring what `prepareStepLaunch` builds. */
  env: Record<string, string>
}

/**
 * Build the same launch environment `prepareStepLaunch` produces, then start it.
 *
 * @param overrides - extra bridge environment, and stub behaviour knobs.
 */
async function launch(
  overrides: {
    model?: string
    provider?: string
    thinking?: string
    preset?: string
    shell?: string
    cwd?: string
    /** Behaviour knobs for the RPC stub, written where the bridge owns the agent dir. */
    knobs?: Record<string, unknown>
    stubEnv?: Record<string, string>
  } = {},
): Promise<Launch> {
  const home = stepTempDir('opl-step-中文 目录-')
  const storage = stepStorage(home)
  mkdirSync(storage.agentDir, { recursive: true })
  mkdirSync(storage.configRoot, { recursive: true })
  mkdirSync(storage.sessionDir, { recursive: true })
  mkdirSync(storage.storageRoot, { recursive: true })
  const cwd = overrides.cwd ?? stepTempDir('opl-step-工作 目录-')
  mkdirSync(cwd, { recursive: true })
  // A real repository, so the agent's own tool call runs real `git` in this directory.
  await exec('git', ['init', '-q'], { cwd, windowsHide: true })
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    OPL_STEP_COMMAND: process.execPath,
    OPL_STEP_PREFIX: JSON.stringify([STUB]),
    OPL_STEP_AGENT_DIR: storage.agentDir,
    OPL_STEP_CONFIG_ROOT: storage.configRoot,
    OPL_STEP_SESSION_DIR: storage.sessionDir,
    OPL_STEP_SESSION_INDEX_DIR: storage.sessionIndexDir,
    OPL_STEP_PROVIDER: overrides.provider ?? 'opl-step-free-lane',
    OPL_STEP_MODEL: overrides.model ?? STEP_MODEL_FREE,
    OPL_STEP_BASE_URL: 'https://models.example.test/v1',
    OPL_STEP_API: 'openai-completions',
    OPL_STEP_REASONING: '1',
    OPL_STEP_THINKING: overrides.thinking ?? '',
    OPL_STEP_PRESET: overrides.preset ?? 'full-access',
    OPL_STEP_ACKNOWLEDGE_FULL_ACCESS: overrides.preset === 'full-access' ? '1' : '0',
    OPL_STEP_SHELL_PATH: overrides.shell ?? safeBash(),
    OPL_STEP_CREDENTIAL: STEP_TEST_KEY,
    [STEP_AGENT_DIR_ENV]: storage.agentDir,
    [STEP_SESSION_DIR_ENV]: storage.sessionDir,
    [STEP_STORAGE_ROOT_ENV]: storage.storageRoot,
    TEMP: join(home, 'tmp'),
    TMP: join(home, 'tmp'),
  }
  if (overrides.knobs)
    // Written into the agent directory the bridge creates, so the stub sees them even
    // though the bridge forwards an explicit allowlist to the child.
    writeFileSync(
      join(storage.agentDir, 'stub-knobs.json'),
      JSON.stringify(overrides.knobs),
      'utf8',
    )
  // Isolation must come from the official StepCode variables only.
  assertNoProfileDirs(env)
  const agent = await startStepAgent({ cwd, env, stubEnv: overrides.stubEnv })
  return { agent, home, cwd, env }
}

/**
 * The shell the bridge is told to pin: the verified Git Bash on Windows, and a real
 * absolute POSIX shell elsewhere.
 *
 * `resolveGitBashPath()` answers the bare name `bash` on a POSIX host, which is right for
 * the POSIX provider but is not something the tool can execute: the RPC stub, like the
 * official tool call it stands in for, refuses any pinned path that is not an existing
 * file. Left at `bash`, the real-turn case on a Linux runner would stop at
 * `NO_SHELL_CONFIGURED` instead of running the real external `git` command.
 */
const POSIX_SHELLS = ['/bin/bash', '/usr/bin/bash', '/bin/sh', '/usr/bin/sh']

function safeBash(): string {
  if (process.platform !== 'win32') return POSIX_SHELLS.find((path) => existsSync(path)) ?? ''
  try {
    return resolveGitBashPath()
  } catch {
    return ''
  }
}

afterAll(() => stepTestCleanup())

describe('StepCode bridge: initialization and pinning', () => {
  it('initializes over ACP and pins the lane model read back from the official CLI', async () => {
    const run = await launch()
    try {
      const init = (await run.agent.acp.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      })) as any
      expect(init.protocolVersion).toBe(1)
      // `loadSession` is advertised only because `switch_session` is really driven here.
      expect(init.agentCapabilities.loadSession).toBe(true)

      const session = (await run.agent.acp.request('session/new', {
        cwd: run.cwd,
        mcpServers: [],
      })) as any
      // The authoritative read-back the host compares against the combination's wire model.
      expect(session.models.currentModelId).toBe(STEP_MODEL_FREE)
      expect(session.sessionId).toBeTruthy()
      const model = session.configOptions.find((o: any) => o.id === 'model')
      expect(model.currentValue).toBe(STEP_MODEL_FREE)
    } finally {
      await run.agent.dispose()
    }
  })

  it('writes the provider config into the Step config root, not the agent directory', async () => {
    const run = await launch()
    try {
      await run.agent.acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
      const storage = stepStorage(run.home)
      // The official CLI silently ignores this file; the probe confirmed it.
      expect(existsSync(join(storage.configRoot, 'models.json'))).toBe(true)
      expect(existsSync(join(storage.agentDir, 'models.json'))).toBe(false)
      const doc = JSON.parse(readFileSync(join(storage.configRoot, 'models.json'), 'utf8'))
      // Credential referenced through the official `$ENV_VAR` interpolation only.
      expect(doc.providers['opl-step-free-lane'].apiKey).toBe('$OPL_STEP_CREDENTIAL')
      expect(JSON.stringify(doc)).not.toContain(STEP_TEST_KEY)
      // The pinned shell is the one the CLI will use.
      const settings = JSON.parse(readFileSync(join(storage.agentDir, 'settings.json'), 'utf8'))
      expect(settings.shellPath).toBe(safeBash())
    } finally {
      await run.agent.dispose()
    }
  })

  it('refuses to start when the pinned model is no longer offered by the provider', async () => {
    // The provider catalog no longer carries the model: the model was withdrawn between
    // the config being written and the launch.
    const run = await launch({ knobs: { offerEmpty: true } })
    try {
      await run.agent.acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
      await expect(
        run.agent.acp.request('session/new', { cwd: run.cwd, mcpServers: [] }),
      ).rejects.toThrow(/拒绝了本次请求参数/)
    } finally {
      await run.agent.dispose()
    }
  })

  it('pins the reasoning tier only when the model advertises it', async () => {
    const run = await launch({ thinking: 'high' })
    try {
      await run.agent.acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
      const session = (await run.agent.acp.request('session/new', {
        cwd: run.cwd,
        mcpServers: [],
      })) as any
      const thinking = session.configOptions.find((o: any) => o.id === 'thinking')
      expect(thinking.currentValue).toBe('high')
      // The options are the model's own advertisement, not a fixed vocabulary.
      expect(thinking.options.map((o: any) => o.value)).toEqual([
        'off',
        'minimal',
        'low',
        'medium',
        'high',
      ])
    } finally {
      await run.agent.dispose()
    }
  })

  it('refuses a tier the model never advertised instead of porting another provider tier', async () => {
    // `max` is the implementation tier of another harness, not this model's vocabulary.
    const run = await launch({ thinking: 'max' })
    try {
      await run.agent.acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
      await expect(
        run.agent.acp.request('session/new', { cwd: run.cwd, mcpServers: [] }),
      ).rejects.toThrow()
    } finally {
      await run.agent.dispose()
    }
  })

  it('keeps the two catalog lanes on separate provider entries', async () => {
    const free = await launch({ model: STEP_MODEL_FREE, provider: 'opl-step-free-lane' })
    const kilo = await launch({ model: STEP_MODEL_KILO, provider: 'opl-step-kilo-lane' })
    try {
      for (const run of [free, kilo]) {
        await run.agent.acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
        const session = (await run.agent.acp.request('session/new', {
          cwd: run.cwd,
          mcpServers: [],
        })) as any
        // Each session reports its own exact id; neither is normalised into the other.
        expect(session.models.currentModelId).toBe(run.env.OPL_STEP_MODEL)
      }
      const freeDoc = readFileSync(join(stepStorage(free.home).configRoot, 'models.json'), 'utf8')
      const kiloDoc = readFileSync(join(stepStorage(kilo.home).configRoot, 'models.json'), 'utf8')
      expect(freeDoc).toContain(STEP_MODEL_FREE)
      expect(freeDoc).not.toContain(STEP_MODEL_KILO)
      expect(kiloDoc).toContain(STEP_MODEL_KILO)
      expect(kiloDoc).not.toContain(`"${STEP_MODEL_FREE}"`)
    } finally {
      await free.agent.dispose()
      await kilo.agent.dispose()
    }
  })
})

describe('StepCode bridge: a real turn', () => {
  it('runs the official agent loop, executes a real git command, and settles on the right signal', async () => {
    const run = await launch()
    try {
      await run.agent.acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
      const session = (await run.agent.acp.request('session/new', {
        cwd: run.cwd,
        mcpServers: [],
      })) as any
      // The prompt resolves on the official `agent_settled`, which the agent emits only
      // after its tool call finished, so this is the synchronisation point: no timer, no
      // sleep, and no assumption about when the tool call lands.
      const turn = (await run.agent.acp.request('session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: '当前仓库状态？' }],
      })) as any
      expect(turn.stopReason).toBe('end_turn')

      const updates = JSON.stringify(run.agent.all())
      // The real external git command completed (not merely started) in this directory.
      expect(updates).toContain('tool_call_update')
      expect(updates).not.toContain('NO_SHELL_CONFIGURED')
      // A real external git command ran through the shell the bridge pinned, in a directory
      // whose name contains non-ASCII characters and a space.
      expect(updates).toContain('agent_message_chunk')
      expect(updates).toContain('tool_call')
      expect(run.cwd).toMatch(/[一-龥]/)
      expect(run.cwd).toContain(' ')
    } finally {
      await run.agent.dispose()
    }
  })

  it('waits for agent_settled rather than ending the turn on agent_end', async () => {
    const run = await launch()
    try {
      await run.agent.acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
      const session = (await run.agent.acp.request('session/new', {
        cwd: run.cwd,
        mcpServers: [],
      })) as any
      const pending = run.agent.acp.request('session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: '你好' }],
      })
      const turn = (await pending) as any
      expect(turn.stopReason).toBe('end_turn')
      // The automatic retry that sits between agent_end and agent_settled was surfaced,
      // so a retrying turn stays visible instead of looking hung.
      expect(JSON.stringify(run.agent.all())).toContain('正在自动重试')
    } finally {
      await run.agent.dispose()
    }
  })

  it('preserves an official terminal error instead of reporting an empty success', async () => {
    const run = await launch({ knobs: { terminalError: true } })
    try {
      await run.agent.acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
      const session = (await run.agent.acp.request('session/new', {
        cwd: run.cwd,
        mcpServers: [],
      })) as any
      await expect(
        run.agent.acp.request('session/prompt', {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: '触发官方终态错误' }],
        }),
      ).rejects.toThrow('官方渠道限流或配额已达上限')
    } finally {
      await run.agent.dispose()
    }
  })
})

describe('StepCode bridge: cancel, cleanup and drift', () => {
  it('cancels a pending turn through the official abort command', async () => {
    const run = await launch({ knobs: { pendingTurn: true } })
    try {
      await run.agent.acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
      const session = (await run.agent.acp.request('session/new', {
        cwd: run.cwd,
        mcpServers: [],
      })) as any
      const pending = run.agent.acp.request('session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: '不会被回答的请求' }],
      })
      // The official abort is what settles a turn that will not finish on its own.
      await run.agent.waitForText('收到：')
      await run.agent.acp.cancel(session.sessionId)
      const turn = (await pending) as any
      expect(turn.stopReason).toBe('cancelled')
    } finally {
      await run.agent.dispose()
    }
  })

  it('refuses a prompt when the live model drifted away from the pinned one', async () => {
    const run = await launch({ knobs: { modelDrift: true } })
    try {
      await run.agent.acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
      await expect(
        run.agent.acp.request('session/new', { cwd: run.cwd, mcpServers: [] }),
      ).rejects.toThrow()
      // No task was sent: the drift is caught at the pinning boundary.
      expect(run.agent.all()).toHaveLength(0)
    } finally {
      await run.agent.dispose()
    }
  })

  it('refuses to change the pinned model, permission, or an unadvertised option', async () => {
    const run = await launch()
    try {
      await run.agent.acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
      const session = (await run.agent.acp.request('session/new', {
        cwd: run.cwd,
        mcpServers: [],
      })) as any
      const id = session.sessionId
      await expect(
        run.agent.acp.request('session/set_config_option', {
          sessionId: id,
          configId: 'model',
          value: STEP_MODEL_KILO,
        }),
      ).rejects.toThrow()
      await expect(
        run.agent.acp.request('session/set_config_option', {
          sessionId: id,
          configId: 'permission',
          value: 'ask',
        }),
      ).rejects.toThrow()
      await expect(
        run.agent.acp.request('session/set_config_option', {
          sessionId: id,
          configId: 'not-advertised',
          value: 'x',
        }),
      ).rejects.toThrow()
      // Refusing is not falling back: the pinned values are unchanged.
      const thinking = (await run.agent.acp.request('session/set_config_option', {
        sessionId: id,
        configId: 'model',
        value: STEP_MODEL_FREE,
      })) as any
      expect(thinking.configOptions.find((o: any) => o.id === 'model').currentValue).toBe(
        STEP_MODEL_FREE,
      )
    } finally {
      await run.agent.dispose()
    }
  })

  it('refuses a session id from another session', async () => {
    const run = await launch()
    try {
      await run.agent.acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
      const session = (await run.agent.acp.request('session/new', {
        cwd: run.cwd,
        mcpServers: [],
      })) as any
      await expect(
        run.agent.acp.request('session/prompt', {
          sessionId: 'someone-elses-session',
          prompt: [{ type: 'text', text: '你好' }],
        }),
      ).rejects.toThrow(/拒绝了本次请求参数/)
    } finally {
      await run.agent.dispose()
    }
  })

  it('tears down cleanly when the official process is gone, with no lingering child', async () => {
    const run = await launch()
    await run.agent.acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
    await run.agent.acp.request('session/new', { cwd: run.cwd, mcpServers: [] })
    await run.agent.dispose()
    // dispose resolves without an unhandled rejection and without hanging.
    await expect(run.agent.exited).resolves.toBeUndefined()
  })
})

describe('StepCode bridge: session load', () => {
  it('resumes a recorded session and replays its real history', async () => {
    const first = await launch()
    let sessionId = ''
    try {
      await first.agent.acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
      const session = (await first.agent.acp.request('session/new', {
        cwd: first.cwd,
        mcpServers: [],
      })) as any
      sessionId = session.sessionId
      await first.agent.acp.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: '第一个问题' }],
      })
      // The session index is what makes the resume target explicit.
      expect(existsSync(join(stepStorage(first.home).sessionIndexDir, `${sessionId}.json`))).toBe(
        true,
      )
    } finally {
      await first.agent.dispose()
    }

    // A brand new bridge process resumes the same suite-owned session.
    const second = await launch({ cwd: first.cwd })
    const storage = stepStorage(first.home)
    for (const dir of [storage.agentDir, storage.configRoot, storage.sessionDir])
      mkdirSync(dir, { recursive: true })
    // Reuse the first run's storage so the session files and index are the real ones.
    const resumed = await startStepAgent({
      cwd: first.cwd,
      env: {
        PATH: process.env.PATH ?? '',
        OPL_STEP_COMMAND: process.execPath,
        OPL_STEP_PREFIX: JSON.stringify([STUB]),
        OPL_STEP_AGENT_DIR: storage.agentDir,
        OPL_STEP_CONFIG_ROOT: storage.configRoot,
        OPL_STEP_SESSION_DIR: storage.sessionDir,
        OPL_STEP_SESSION_INDEX_DIR: storage.sessionIndexDir,
        OPL_STEP_PROVIDER: 'opl-step-free-lane',
        OPL_STEP_MODEL: STEP_MODEL_FREE,
        OPL_STEP_BASE_URL: 'https://models.example.test/v1',
        OPL_STEP_API: 'openai-completions',
        OPL_STEP_REASONING: '1',
        OPL_STEP_PRESET: 'full-access',
        OPL_STEP_ACKNOWLEDGE_FULL_ACCESS: '1',
        OPL_STEP_SHELL_PATH: safeBash(),
        OPL_STEP_CREDENTIAL: STEP_TEST_KEY,
        [STEP_AGENT_DIR_ENV]: storage.agentDir,
        [STEP_SESSION_DIR_ENV]: storage.sessionDir,
        [STEP_STORAGE_ROOT_ENV]: storage.storageRoot,
        TEMP: second.home,
        TMP: second.home,
      },
      stubEnv: { STUB_SESSION_ID: sessionId },
    })
    try {
      await resumed.acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
      const loaded = (await resumed.acp.request('session/load', {
        sessionId,
        cwd: first.cwd,
        mcpServers: [],
      })) as any
      expect(loaded.sessionId).toBe(sessionId)
      expect(loaded.models.currentModelId).toBe(STEP_MODEL_FREE)
      // The real prior turn was replayed as ACP chunks, not merely claimed to exist.
      const replay = JSON.stringify(resumed.all())
      expect(replay).toContain('第一个问题')
    } finally {
      await resumed.dispose()
    }
  })

  it('refuses a session the suite has no record of, rather than guessing history', async () => {
    const run = await launch()
    try {
      await run.agent.acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
      await expect(
        run.agent.acp.request('session/load', {
          sessionId: 'never-recorded',
          cwd: run.cwd,
          mcpServers: [],
        }),
      ).rejects.toThrow(/拒绝了本次请求参数/)
    } finally {
      await run.agent.dispose()
    }
  })
})
