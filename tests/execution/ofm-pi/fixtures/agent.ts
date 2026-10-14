/**
 * Test-only harness that drives the real compiled bridge through the suite's own ACP
 * transport, against the **real official Pi CLI** installed for this task.
 *
 * The bridge is bundled with the repository's esbuild, which is exactly how the packager
 * will build it (`pi-bridge.ts` → `package/lib/pi-bridge.mjs`). Bundling here rather than
 * importing the TypeScript module keeps the test honest: the process under test is a
 * separate Node program speaking ACP over stdio, not a same-process function call, and the
 * child it launches is the genuine official `pi` binary rather than a stub.
 *
 * The model endpoint is a keyless controlled loopback server (see `./provider.ts`), so no
 * real model is contacted and no real credential exists anywhere in these tests.
 *
 * Synchronisation is by awaited protocol traffic only. Nothing polls on a timer or sleeps
 * to guess whether the agent caught up.
 */
import { build } from 'esbuild'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AcpProcess } from '../../../../src/execution/host/acp.ts'
import { PI_CREDENTIAL_ENV } from '../../../../src/execution/host/adapters/pi/pi-config.ts'

const BRIDGE_SOURCE = fileURLToPath(
  new URL('../../../../src/execution/host/adapters/pi/pi-bridge.ts', import.meta.url),
)

/** Root for every temporary artefact these tests create. Owned by this task. */
const BASE = process.env.OPL_PI_TEST_ROOT ?? tmpdir()
mkdirSync(BASE, { recursive: true })
const ROOT = mkdtempSync(join(BASE, 'opl-pi-tests-'))

/** Where the official Pi CLI was installed for this task's probes. */
const PI_PACKAGE =
  process.env.OPL_PI_PACKAGE ??
  'C:/Users/root/Documents/Codex/repair-20261013/ofm-harness-adaptation/pi/probe/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'

/**
 * The genuine official `pi` entry point, or `undefined` when this task's copy is absent.
 *
 * Cases that need it are skipped rather than faked: substituting a stub would silently
 * turn "the official product does X" into "a test double does X".
 */
export const realPiCli = (): string | undefined => (existsSync(PI_PACKAGE) ? PI_PACKAGE : undefined)

let bridgePath = ''
const cleanups: string[] = []

/** Bundle the bridge once per run and return its absolute path. */
export async function piBridgePath(): Promise<string> {
  if (bridgePath) return bridgePath
  await mkdir(ROOT, { recursive: true })
  const out = join(ROOT, 'pi-bridge.mjs')
  const result = await build({
    entryPoints: [BRIDGE_SOURCE],
    outfile: out,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'silent',
    write: false,
  })
  for (const file of result.outputFiles) await writeFile(file.path, file.contents)
  bridgePath = out
  return out
}

/**
 * Remove everything these tests created.
 *
 * Best effort by design: a bridge that was force-disposed can leave the official child
 * process holding a session file for a moment after the test ends, and Windows refuses to
 * delete a file with an open handle. Everything lives under this task's own temporary root,
 * so leaving a directory behind is harmless — failing the suite over it is not.
 */
export function piTestCleanup(): void {
  for (const path of cleanups.splice(0)) removeBestEffort(path)
  removeBestEffort(ROOT)
}

function removeBestEffort(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch {
    // Retried already; the leftover is inside this task's temporary root.
  }
}

/** Create an isolated temp directory whose name mixes non-ASCII text and a space. */
export function piTempDir(prefix = 'opl-pi-'): string {
  // Created here as well as in `beforeAll`, so a spec that only needs a scratch directory
  // does not depend on another spec's hook having run first.
  mkdirSync(ROOT, { recursive: true })
  const dir = mkdtempSync(join(ROOT.replace(/\/$/, ''), prefix))
  cleanups.push(dir)
  return dir
}

export interface PiAgentOptions {
  /** Working directory for the child. Defaults to a CJK-and-space directory. */
  cwd: string
  /** Environment handed to the bridge, matching `preparePiLaunch`'s contract. */
  env: Record<string, string>
}

export interface PiAgent {
  acp: AcpProcess
  updates: unknown[]
  /** Every `session/update` payload received so far. */
  all(): unknown[]
  /**
   * Resolve once a notification carrying `text` has arrived. No polling, no sleeps.
   *
   * The waiter is matched against everything received so far first, so a frame that
   * arrived before the wait was installed still resolves it.
   */
  waitForText(text: string, timeoutMs?: number): Promise<void>
  /** Resolve once a tool_call update with `status` has arrived. */
  waitForToolStatus(toolCallId: string, status: string): Promise<void>
  exited: Promise<void>
  dispose(): Promise<void>
}

/**
 * Start the bridge over the real ACP transport.
 *
 * Synchronisation is by request id and awaited notifications; the returned helpers resolve
 * on the matching frame instead of on a timer.
 */
export async function startPiAgent(options: PiAgentOptions): Promise<PiAgent> {
  const updates: unknown[] = []
  const textWaiters: { text: string; resolve: () => void; reject: (e: Error) => void }[] = []
  const toolWaiters: {
    id: string
    status: string
    resolve: () => void
    reject: (e: Error) => void
  }[] = []
  let resolveExit!: () => void
  const exited = new Promise<void>((done) => {
    resolveExit = done
  })
  const bridge = await piBridgePath()
  const acp = new AcpProcess(
    process.execPath,
    [bridge],
    options.cwd,
    options.env,
    (value) => {
      updates.push(value)
      for (let i = textWaiters.length - 1; i >= 0; i--) {
        const waiter = textWaiters[i]!
        if (JSON.stringify(value).includes(waiter.text)) {
          textWaiters.splice(i, 1)
          waiter.resolve()
        }
      }
      // Waiters are matched, never dropped: unrelated frames (message chunks) legitimately
      // arrive before the tool event, and discarding a waiter on the first non-match would
      // turn a real miss into a silent hang.
      for (let i = toolWaiters.length - 1; i >= 0; i--) {
        const waiter = toolWaiters[i]!
        const json = JSON.stringify(value)
        if (json.includes(waiter.id) && json.includes(`"${waiter.status}"`)) {
          toolWaiters.splice(i, 1)
          waiter.resolve()
        }
      }
    },
    () => {},
    () => resolveExit(),
  )
  return {
    acp,
    updates,
    all: () => updates,
    waitForText(text, timeoutMs = 30_000) {
      const seen = updates.find((value) => JSON.stringify(value).includes(text))
      if (seen) return Promise.resolve()
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error(`等待官方 Pi 事件超时：${text}`)), timeoutMs)
        textWaiters.push({ text, resolve: () => (clearTimeout(timer), resolve()), reject })
      })
    },
    waitForToolStatus(id, status, timeoutMs = 30_000) {
      // Matched against everything received so far first. The tool can finish before this
      // waiter is installed, and a waiter that only looked at *future* frames would then wait
      // forever — a sleep could not fix that without becoming a race.
      const seen = updates.find((value) => {
        const json = JSON.stringify(value)
        return json.includes(id) && json.includes(`"${status}"`)
      })
      if (seen) return Promise.resolve()
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(Error(`等待工具状态超时：${id} ${status}`)),
          timeoutMs,
        )
        toolWaiters.push({
          id,
          status,
          resolve: () => (clearTimeout(timer), resolve()),
          reject,
        })
      })
    },
    exited,
    async dispose() {
      await acp.dispose()
    },
  }
}

/** The credential value tests place in the bridge environment. Not a real secret. */
export const PI_TEST_KEY = 'source-owned-key-not-a-real-secret'

/** Assert the launch environment carries the credential without leaking it elsewhere. */
export function credentialOf(env: Record<string, string>): string | undefined {
  return env[PI_CREDENTIAL_ENV]
}
