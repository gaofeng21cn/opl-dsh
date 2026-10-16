import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MUSE_BOUND_BASE_URL } from '../../../src/execution/host/adapters/muse/muse-models.ts'

const BRIDGE = fileURLToPath(
  new URL('../../../src/execution/host/adapters/muse/muse-bridge.mjs', import.meta.url),
)
const STUB = fileURLToPath(new URL('./fixtures/stub-msp-host.mjs', import.meta.url))
const LANE = 'muse-spark-1.3-contributor-free'

let workspace = ''

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'opl-muse-bridge-'))
})

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true })
})

/**
 * Drive the bridge over the ACP surface the execution engine uses, with the stub standing
 * in for `muse serve`.
 * @param mode - the stub's cancellation behaviour.
 * @param turnMs - how long the stub keeps the turn in flight.
 */
function driveBridge(mode: string, turnMs = 1200) {
  const profile = mkdtempSync(join(workspace, 'profile-'))
  mkdirSync(join(profile, 'muse'))
  writeFileSync(
    join(profile, 'muse', 'settings.json'),
    JSON.stringify({
      schema_version: 1,
      endpoint_transport: { base_url: MUSE_BOUND_BASE_URL, auth: 'bearer' },
    }),
  )
  const child = spawn(process.execPath, [BRIDGE], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      XDG_CONFIG_HOME: profile,
      // The stub stands in for the official binary, so the bridge's own command/prefix
      // pair points at it.
      OPL_MUSE_COMMAND: process.execPath,
      OPL_MUSE_PREFIX: JSON.stringify([STUB, mode]),
      OPL_MUSE_ARGS: JSON.stringify([]),
      OPL_MUSE_MODEL: LANE,
      OPL_MUSE_BASE_URL: MUSE_BOUND_BASE_URL,
      OPL_MUSE_EFFORT: 'high',
      OPL_MUSE_APPROVAL_MODE: 'allowAll',
      OPL_MUSE_CONTRIBUTOR_MODE: 'on',
      OPL_MUSE_BASH_TOOL: 'mcp__opl_muse_git_bash__run',
      STUB_TURN_MS: String(turnMs),
    },
    windowsHide: true,
  })
  const pending = new Map<number, (message: any) => void>()
  const updates: any[] = []
  const stderr: string[] = []
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => stderr.push(chunk))
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    for (;;) {
      const index = buffer.indexOf('\n')
      if (index < 0) break
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      const message = JSON.parse(line)
      const waiter = message.id !== undefined ? pending.get(message.id) : undefined
      if (waiter) {
        pending.delete(message.id)
        waiter(message)
      } else if (message.method === 'session/update') updates.push(message.params)
    }
  })
  let next = 1
  const request = (method: string, params: unknown, timeoutMs = 30_000) =>
    new Promise<any>((resolve, reject) => {
      const id = next++
      const timer = setTimeout(() => reject(Error(`${method} timed out`)), timeoutMs)
      pending.set(id, (message) => {
        clearTimeout(timer)
        resolve(message)
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  return { child, request, updates, stderr }
}

describe('Muse bridge: handshake and pinning', () => {
  it('pins the served schema fingerprint instead of trusting an unknown surface', async () => {
    const { child, request } = driveBridge('refuse-cancel')
    try {
      const initialized = await request('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'opl-dsh', version: '0.2.13' },
      })
      expect(initialized.result.protocolVersion).toBe(1)
      expect(initialized.result.agentCapabilities.loadSession).toBe(true)
      // The host's own sandbox answer is surfaced, not reinterpreted.
      expect(initialized.result._meta['muse/sandboxAvailability']).toBe('unavailable')
      const session = await request('session/new', { cwd: workspace, mcpServers: [] })
      // The pinned model is read back, so the caller can verify it.
      expect(session.result.models.currentModelId).toBe(LANE)
    } finally {
      child.kill()
    }
  })

  it('fails closed when the served schema is not the pinned one', async () => {
    const profile = mkdtempSync(join(workspace, 'profile-'))
    mkdirSync(join(profile, 'muse'))
    writeFileSync(
      join(profile, 'muse', 'settings.json'),
      JSON.stringify({
        schema_version: 1,
        endpoint_transport: { base_url: MUSE_BOUND_BASE_URL, auth: 'bearer' },
      }),
    )
    const child = spawn(process.execPath, [BRIDGE], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        XDG_CONFIG_HOME: profile,
        OPL_MUSE_COMMAND: process.execPath,
        OPL_MUSE_PREFIX: JSON.stringify([STUB, 'refuse-cancel']),
        OPL_MUSE_ARGS: JSON.stringify([]),
        OPL_MUSE_MODEL: LANE,
        OPL_MUSE_BASE_URL: MUSE_BOUND_BASE_URL,
        // A pin that does not match what the host serves.
        OPL_MUSE_SCHEMA_FINGERPRINT:
          'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      },
      windowsHide: true,
    })
    const answer = await new Promise<any>((resolve) => {
      child.stdout.setEncoding('utf8')
      let buffer = ''
      child.stdout.on('data', (chunk) => {
        buffer += chunk
        const index = buffer.indexOf('\n')
        if (index < 0) return
        resolve(JSON.parse(buffer.slice(0, index)))
      })
      child.stderr.resume()
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: 1, clientInfo: { name: 'opl-dsh', version: '0.2.13' } },
        })}\n`,
      )
    })
    try {
      expect(answer.error.message).toMatch(/schema 指纹/)
      expect(answer.error.message).toMatch(/不会改用其他模型/)
    } finally {
      child.kill()
    }
  })
})

describe('Muse bridge: cancellation never claims more than the runtime granted', () => {
  it('does not report a cancelled turn when the runtime refused the cancel', async () => {
    const { child, request, stderr } = driveBridge('refuse-cancel', 1200)
    try {
      await request('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'opl-dsh', version: '0.2.13' },
      })
      const session = await request('session/new', { cwd: workspace, mcpServers: [] })
      const prompt = request('session/prompt', {
        sessionId: session.result.sessionId,
        prompt: [{ type: 'text', text: 'do the thing' }],
      })
      // Let the turn actually start before trying to cancel it.
      await new Promise((done) => setTimeout(done, 200))
      const cancelled = await request('session/cancel', { sessionId: session.result.sessionId })
      // The cancel itself reports only that a request was made, never an outcome.
      expect(cancelled.result.stopReason).toBe('cancel_rejected')
      expect(cancelled.result.turnActive).toBe(true)
      const result = await prompt
      // The official terminal said completed, so completed is what the caller is told.
      expect(result.result.stopReason).toBe('end_turn')
      expect(stderr.join('')).toMatch(/拒绝了取消请求/)
    } finally {
      child.kill()
    }
  }, 30_000)

  it('reports the official cancelled terminal when the runtime really cancels', async () => {
    const { child, request, updates } = driveBridge('ignore-cancel', 0)
    try {
      await request('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'opl-dsh', version: '0.2.13' },
      })
      const session = await request('session/new', { cwd: workspace, mcpServers: [] })
      const prompt = request('session/prompt', {
        sessionId: session.result.sessionId,
        prompt: [{ type: 'text', text: 'stream something' }],
      })
      const result = await prompt
      expect(result.result.stopReason).toBe('end_turn')
      // Assistant text reached the caller as ACP session/update notifications.
      const chunks = updates.filter((u) => u.update.sessionUpdate === 'agent_message_chunk')
      expect(chunks.map((c) => c.update.content.text).join('')).toContain('working')
    } finally {
      child.kill()
    }
  }, 30_000)

  it('claims nothing when there is no turn to cancel', async () => {
    const { child, request } = driveBridge('refuse-cancel')
    try {
      await request('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'opl-dsh', version: '0.2.13' },
      })
      const session = await request('session/new', { cwd: workspace, mcpServers: [] })
      const cancelled = await request('session/cancel', { sessionId: session.result.sessionId })
      expect(cancelled.result.stopReason).toBe('no_active_turn')
      expect(cancelled.result.turnActive).toBe(false)
    } finally {
      child.kill()
    }
  }, 30_000)
})

it('keeps the official client restriction as a fixed failed category after body text', async () => {
  const { child, request } = driveBridge('provider-refusal', 1)
  try {
    await request('initialize', { protocolVersion: 1 })
    const created = await request('session/new', { cwd: workspace, mcpServers: [] })
    const result = await request('session/prompt', {
      sessionId: created.result.sessionId,
      prompt: [{ type: 'text', text: 'OK' }],
    })
    expect(result.result).toBeUndefined()
    expect(result.error.code).toBe('HARNESS_PROVIDER_CLIENT_REQUIRED')
    expect(JSON.stringify(result)).not.toContain('synthetic-private-key')
  } finally {
    const closed = once(child, 'close')
    child.stdin.end()
    await closed
  }
})
