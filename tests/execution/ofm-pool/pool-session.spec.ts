/**
 * Model, mode and reasoning pinning over the real ACP config-option surface.
 *
 * The stand-in agent transcribes the semantics measured on the official 1.0.16
 * Windows package: `session/new` advertises `mode` with exactly `default`,
 * `accept-edits` and `always-allow`, plus an `agent_mode` the suite never writes;
 * `model` lists the ids the configured endpoint advertises and rejects anything
 * else with "standalone model \"<id>\" is not available"; and a thought-level arm
 * exists only for a model whose catalog row carries reasoning metadata.
 */
import { describe, expect, it } from 'vitest'
import { HarnessConfigurationError } from '../../../src/execution/host/acp.ts'
import {
  POOL_MODE_OPTION,
  POOL_MODEL_OPTION,
  POOL_THOUGHT_OPTION,
  POOL_VERIFIED_VERSION,
  assertPoolAcpVersion,
  poolAdapter,
} from '../../../src/execution/host/adapters/pool/index.ts'
import { POOL_LAGUNA_S, POOL_LAGUNA_XS, poolRecord, poolRef } from './fixtures/records.ts'
import type {
  AcpRequestSurface,
  AcpSessionSnapshot,
} from '../../../src/execution/host/adapters/types.ts'

interface CatalogRow {
  readonly id: string
  readonly efforts?: readonly string[]
}

class FakePoolAgent implements AcpRequestSurface {
  readonly writes: { configId: string; value: string }[] = []
  /** Answers a write with a value the agent never stored. */
  driftTo: string | undefined
  /** Drops an arm from the advertisement entirely. */
  hide: string | undefined
  /** Drops an arm only from the answer to a write, as a partial read-back would. */
  dropFromAnswer: string | undefined
  constructor(
    private readonly catalog: readonly CatalogRow[],
    private model: string,
    private mode = 'default',
    private thought: string | undefined = undefined,
  ) {}

  private advertise(): unknown {
    const row = this.catalog.find((item) => item.id === this.model)
    const options: Record<string, any>[] = [
      {
        type: 'select',
        id: 'mode',
        currentValue: this.mode,
        options: ['default', 'accept-edits', 'always-allow'].map((value) => ({ value })),
      },
      {
        type: 'select',
        id: 'agent_mode',
        currentValue: 'build',
        options: [{ value: 'build' }, { value: 'plan' }],
      },
      {
        type: 'select',
        id: 'model',
        currentValue: this.model,
        options: this.catalog.map((item) => ({ value: item.id })),
      },
    ]
    if (row?.efforts)
      options.push({
        type: 'select',
        id: POOL_THOUGHT_OPTION,
        currentValue: this.thought ?? row.efforts[0],
        options: row.efforts.map((value) => ({ value })),
      })
    return options.filter((option) => option.id !== this.hide)
  }

  async request(method: string, params: object): Promise<unknown> {
    if (method !== 'session/set_config_option') throw Error(`unexpected ${method}`)
    const { configId, value } = params as { configId: string; value: string }
    this.writes.push({ configId, value })
    if (configId === 'model' && !this.catalog.some((item) => item.id === value))
      throw Error(`standalone model "${value}" is not available`)
    if (configId === 'mode' && !['default', 'accept-edits', 'always-allow'].includes(value))
      throw Error(`unknown mode ${value}`)
    if (configId === POOL_MODEL_OPTION) this.model = value
    if (configId === 'mode') this.mode = value
    if (configId === POOL_THOUGHT_OPTION) this.thought = value
    const advertised = this.advertise() as Record<string, any>[]
    return {
      configOptions: advertised
        .filter((option) => option.id !== this.dropFromAnswer)
        .map((option) =>
          this.driftTo && option.id === configId
            ? { ...option, currentValue: this.driftTo }
            : option,
        ),
    }
  }

  current(configId: string): string | undefined {
    return (this.advertise() as Record<string, any>[]).find((option) => option.id === configId)
      ?.currentValue
  }

  snapshot(): AcpSessionSnapshot {
    return {
      agent: { agentInfo: { name: 'pool-acp', version: POOL_VERIFIED_VERSION }, loadSession: true },
      session: { sessionId: 'acp-1' },
      configOptions: this.advertise(),
    } as AcpSessionSnapshot
  }
}

const catalog: CatalogRow[] = [
  { id: POOL_LAGUNA_S },
  { id: POOL_LAGUNA_XS },
  { id: 'poolside/laguna-s-2.1' },
]

describe('pool session pinning', () => {
  it('pins the exact model and the permission mode, then reads both back', async () => {
    const agent = new FakePoolAgent(catalog, 'poolside/laguna-s-2.1')
    const result = await poolAdapter.configureSession!(agent, poolRecord(), agent.snapshot())
    expect(agent.current(POOL_MODEL_OPTION)).toBe(POOL_LAGUNA_S)
    expect(agent.current(POOL_MODE_OPTION)).toBe('always-allow')
    expect(agent.writes).toEqual([
      { configId: POOL_MODEL_OPTION, value: POOL_LAGUNA_S },
      { configId: POOL_MODE_OPTION, value: 'always-allow' },
    ])
    expect(result?.configOptions).toBeDefined()
  })

  it('pins a second official id without changing any other rule', async () => {
    const agent = new FakePoolAgent(catalog, POOL_LAGUNA_XS)
    const record = poolRecord({ modelRef: poolRef(POOL_LAGUNA_XS) })
    await poolAdapter.configureSession!(agent, record, agent.snapshot())
    expect(agent.current(POOL_MODEL_OPTION)).toBe(POOL_LAGUNA_XS)
  })

  it('refuses a model the official picker does not offer', async () => {
    const agent = new FakePoolAgent([{ id: 'poolside/laguna-s-2.1' }], 'poolside/laguna-s-2.1')
    await expect(
      poolAdapter.configureSession!(agent, poolRecord(), agent.snapshot()),
    ).rejects.toThrow(/广告的 model 不含所需取值/u)
  })

  it('refuses when the agent answers with a different model than it stored', async () => {
    const agent = new FakePoolAgent(catalog, 'poolside/laguna-s-2.1')
    agent.driftTo = 'poolside/laguna-xs-2.1:free'
    await expect(
      poolAdapter.configureSession!(agent, poolRecord(), agent.snapshot()),
    ).rejects.toThrow(/会话 model 与要求的/u)
  })

  it('refuses when the answer to the write no longer advertises the model', async () => {
    const agent = new FakePoolAgent(catalog, 'poolside/laguna-s-2.1')
    // The opening advertisement is complete, so the request passes its pre-check; the
    // answer then omits the arm, which makes the pinned value unverifiable.
    agent.dropFromAnswer = POOL_MODEL_OPTION
    await expect(
      poolAdapter.configureSession!(agent, poolRecord(), agent.snapshot()),
    ).rejects.toThrow(/未广告 model 配置项/u)
  })

  it('refuses when the opening advertisement never offered the model', async () => {
    const agent = new FakePoolAgent(catalog, 'poolside/laguna-s-2.1')
    agent.hide = POOL_MODEL_OPTION
    await expect(
      poolAdapter.configureSession!(agent, poolRecord(), agent.snapshot()),
    ).rejects.toThrow(/启动广告中缺少 model 配置项/u)
  })

  it('writes nothing for reasoning when the caller expressed no choice', async () => {
    const agent = new FakePoolAgent(
      [{ id: POOL_LAGUNA_S, efforts: ['none', 'high'] }],
      POOL_LAGUNA_S,
    )
    await poolAdapter.configureSession!(agent, poolRecord(), agent.snapshot())
    expect(agent.writes.some((write) => write.configId === POOL_THOUGHT_OPTION)).toBe(false)
  })

  it('pins an advertised thought level and reads it back', async () => {
    const agent = new FakePoolAgent(
      [{ id: POOL_LAGUNA_S, efforts: ['none', 'high', 'max'] }],
      POOL_LAGUNA_S,
      'default',
      'none',
    )
    await poolAdapter.configureSession!(
      agent,
      poolRecord({ reasoningEffort: 'high' }),
      agent.snapshot(),
    )
    expect(agent.current(POOL_THOUGHT_OPTION)).toBe('high')
  })

  it('refuses a tier the model never advertised instead of dropping it', async () => {
    const agent = new FakePoolAgent(
      [{ id: POOL_LAGUNA_S, efforts: ['none', 'high'] }],
      POOL_LAGUNA_S,
    )
    // Now refused by the startup gate, before any write is sent.
    await expect(
      poolAdapter.configureSession!(
        agent,
        poolRecord({ reasoningEffort: 'max' }),
        agent.snapshot(),
      ),
    ).rejects.toThrow(/启动广告的 thought_level 不含所需取值/u)
  })

  it('refuses an explicit tier when the model row has no reasoning arm at all', async () => {
    const agent = new FakePoolAgent([{ id: POOL_LAGUNA_S }], POOL_LAGUNA_S)
    await expect(
      poolAdapter.configureSession!(
        agent,
        poolRecord({ reasoningEffort: 'max' }),
        agent.snapshot(),
      ),
    ).rejects.toThrow(/启动广告中缺少 thought_level 配置项/u)
  })
})

describe('pool session verification', () => {
  it('accepts a session that still advertises the pinned values', () => {
    const agent = new FakePoolAgent(catalog, POOL_LAGUNA_S, 'always-allow')
    expect(() => poolAdapter.verifySession!(poolRecord(), agent.snapshot())).not.toThrow()
  })

  it('fails closed when the model drifted', () => {
    const agent = new FakePoolAgent(catalog, POOL_LAGUNA_XS, 'always-allow')
    expect(() => poolAdapter.verifySession!(poolRecord(), agent.snapshot())).toThrow(
      /会话 model 与要求的/u,
    )
  })

  it('fails closed when the permission mode drifted back to asking', () => {
    const agent = new FakePoolAgent(catalog, POOL_LAGUNA_S, 'default')
    expect(() => poolAdapter.verifySession!(poolRecord(), agent.snapshot())).toThrow(
      /会话 mode 与要求的/u,
    )
  })

  it('fails closed when a pinned thought level drifted', () => {
    const agent = new FakePoolAgent(
      [{ id: POOL_LAGUNA_S, efforts: ['none', 'high'] }],
      POOL_LAGUNA_S,
      'always-allow',
      'none',
    )
    const record = poolRecord({ reasoningEffort: 'high' })
    expect(() => poolAdapter.verifySession!(record, agent.snapshot())).toThrow(
      /会话 thought_level 与要求的/u,
    )
  })

  it('refuses a session that advertises no configuration options at all', () => {
    const snapshot = {
      agent: { agentInfo: { name: 'pool-acp', version: POOL_VERIFIED_VERSION } },
      session: { sessionId: 'acp-1' },
    } as AcpSessionSnapshot
    // An absent advertisement cannot confirm the pinned values, so it fails closed
    // before the next prompt instead of being treated as "nothing to check".
    expect(() => poolAdapter.verifySession!(poolRecord(), snapshot)).toThrow(/未广告配置项/u)
  })
})

describe('pool agent version gate', () => {
  const snapshot = (name: unknown, version: unknown): AcpSessionSnapshot =>
    ({ agent: { agentInfo: { name, version } }, session: {} }) as AcpSessionSnapshot

  it('accepts the verified release and later 1.0.x builds', () => {
    expect(() => assertPoolAcpVersion(snapshot('pool-acp', '1.0.16'))).not.toThrow()
    expect(() => assertPoolAcpVersion(snapshot('pool-acp', '1.0.17'))).not.toThrow()
  })

  it('refuses another implementation, an older release and an unreadable version', () => {
    for (const [name, version] of [
      ['some-other-agent', '1.0.16'],
      ['pool-acp', '1.0.15'],
      ['pool-acp', '2.0.0'],
      ['pool-acp', ''],
      ['pool-acp', 'v1.0.16'],
    ] as [unknown, unknown][])
      expect(() => assertPoolAcpVersion(snapshot(name, version))).toThrow(HarnessConfigurationError)
  })
})
