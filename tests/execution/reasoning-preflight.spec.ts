import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  probeHarnessReasoning,
  readHarnessReasoning,
} from '../../src/execution/host/reasoning-preflight.ts'
import { minimaxModelValue, minimaxReasoning } from '../../src/execution/host/adapters/minimax.ts'
import type { HarnessAdapter } from '../../src/execution/host/adapters/types.ts'
import type { HarnessSession } from '../../src/execution/contracts/sessions.ts'

function record(): HarnessSession {
  return {
    id: 'probe',
    combination: 'fixture',
    harnessRef: 'kimi-code',
    modelRef: { provider: 'our-free-model', model: 'moonshotai/kimi-k3' },
    cwd: tmpdir(),
    origin: { kind: 'dsh', sessionId: 'native' },
    sandbox: 'workspace',
    acpSessionId: '',
    title: 'probe',
    createdAt: '',
    updatedAt: '',
    turns: [],
  }
}
describe('external reasoning preflight', () => {
  it('keeps only offered values instead of a generic high/max ladder', () => {
    expect(
      readHarnessReasoning(record(), [
        { id: 'thinking', options: [{ value: 'off' }, { value: 'on' }] },
      ]),
    ).toEqual([
      { id: 'off', name: 'off' },
      { id: 'on', name: 'on' },
    ])
  })
  it('does not reflect arbitrary CLI labels or duplicate values', () => {
    expect(
      readHarnessReasoning(record(), [
        { id: 'thinking', options: [{ value: 'high', name: 'private data' }, { value: 'high' }] },
      ]),
    ).toEqual([{ id: 'high', name: 'high' }])
  })
  it('distinguishes absent advertisements from a model with no control', () => {
    expect(readHarnessReasoning(record(), undefined)).toBeUndefined()
    expect(readHarnessReasoning(record(), [{ id: 'model', options: [] }])).toEqual([])
    expect(
      readHarnessReasoning(record(), [{ id: 'thinking', options: [{ value: null }] }]),
    ).toBeUndefined()
  })
  it('reads the camel-case MiniMax effort option', () => {
    expect(
      readHarnessReasoning(record(), [{ id: 'thinkingEffort', options: [{ value: 'max' }] }]),
    ).toEqual([{ id: 'max', name: 'max' }])
  })
  it('offers M3 thinking variants only when the CLI advertises them', () => {
    const m3 = {
      ...record(),
      harnessRef: 'minimax-code',
      modelRef: { provider: 'minimax-official', model: 'MiniMax-M3' },
    }
    const { spec } = minimaxReasoning(m3.modelRef)!
    expect(
      readHarnessReasoning(m3, [
        { id: 'model', options: [{ value: minimaxModelValue(spec, 'off') }] },
      ]),
    ).toEqual([{ id: 'off', name: 'off' }])
  })
  it('configures and reads a real ACP child without sending a prompt or attaching tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reasoning-preflight-'))
    const methods = join(root, 'methods')
    const adapter = {
      configureSession: async (acp, _record, snapshot) =>
        acp.request('session/set_config_option', {
          sessionId: snapshot.session.sessionId,
          configId: 'model',
          value: 'fixture',
        }),
      verifySession: (_record, snapshot) => expect(snapshot.configOptions).toHaveLength(2),
    } as HarnessAdapter
    try {
      const session = { ...record(), cwd: root }
      const result = await probeHarnessReasoning(adapter, session, {
        home: root,
        command: process.execPath,
        args: [fileURLToPath(new URL('./fixtures/reasoning-preflight.mjs', import.meta.url))],
        env: { ...process.env, PROBE_METHODS: methods },
      })
      expect(result.status).toBe('known')
      expect(result.efforts.map((effort) => effort.id)).toEqual(['off', 'on'])
      expect(await readFile(methods, 'utf8')).toBe(
        'initialize\nsession/new\nsession/set_config_option\n',
      )
      expect(session).not.toHaveProperty('nativeSessionId')
      expect(session.turns).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 20000)
})
