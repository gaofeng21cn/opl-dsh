/**
 * Adapter surface for the official Pi Coding Agent: which pairings exist, which protocols
 * can really be driven, which permissions can honestly be advertised, and what the adapter
 * refuses. These are the declarations other shared code reads, so they are asserted directly
 * rather than inferred from a run.
 */
import { describe, expect, it } from 'vitest'
import {
  PI_CODE_MODELS,
  PI_HARNESS,
  PI_MODEL_INKLING,
  PI_MODEL_LFM,
  PI_MODEL_NEMOTRON,
  PI_PERMISSIONS,
  PI_PROVIDER,
  PI_PROTOCOLS,
  isPiCodeModel,
  isPiProtocol,
  piApiForProtocol,
  piCodeModels,
  piConfigOption,
  piLane,
  piLaneProtocol,
  piLaneReasoning,
  piThinkingValue,
} from '../../../src/execution/host/adapters/pi/index.ts'
import { createPiAdapter } from '../../../src/execution/host/adapters/pi/index.ts'
import type { ModelRef } from '../../../src/execution/contracts/catalog.ts'

const ref = (model: string, provider = PI_PROVIDER): ModelRef => ({ provider, model })

describe('Pi adapter capabilities', () => {
  const adapter = createPiAdapter('bridge.mjs')

  it('advertises only what the official product can actually do', () => {
    expect(adapter.id).toBe(PI_HARNESS)
    expect(adapter.transport).toBe('acp')
    expect(adapter.capabilities.transport).toBe('official-sdk')
    // The documented machine interface really is driven, so these are true claims.
    expect(adapter.capabilities.sessionLoad).toBe(true)
    expect(adapter.capabilities.cancel).toBe(true)
    expect(adapter.capabilities.customEndpoint).toBe(true)
    // Pi has no review command of any kind, so Auto Review is refused rather than faked.
    expect(adapter.capabilities.autoReview).toBe('unsupported')
    // Pi has no approval gate and no filesystem boundary: only full access is honest.
    expect(adapter.capabilities.permissions).toEqual(['full-access'])
    expect(PI_PERMISSIONS).toEqual(['full-access'])
  })

  it('matches only the three named lanes under this provider', () => {
    expect(adapter.matches(ref(PI_MODEL_NEMOTRON))).toBe(true)
    expect(adapter.matches(ref(PI_MODEL_LFM))).toBe(true)
    expect(adapter.matches(ref(PI_MODEL_INKLING))).toBe(true)
    // Excluded from this run's adaptation scope, and never deleted from the plugin catalog.
    expect(adapter.matches(ref('openai/gpt-oss-20b'))).toBe(false)
    expect(adapter.matches(ref('jev-1.13-free'))).toBe(false)
    expect(adapter.matches(ref('nvidia/nemotron-3.5-content-safety:free'))).toBe(false)
    // A Pi-shaped id from another owner is not absorbed.
    expect(adapter.matches(ref(PI_MODEL_NEMOTRON, 'somebody-else'))).toBe(false)
    expect(PI_CODE_MODELS).toHaveLength(3)
    expect(piCodeModels().map((m) => m.provider)).toEqual([PI_PROVIDER, PI_PROVIDER, PI_PROVIDER])
  })

  it('keeps the three lanes separate, with their own provider keys', () => {
    const providers = PI_CODE_MODELS.map((model) => piLane(ref(model))!.provider)
    expect(new Set(providers).size).toBe(3)
    expect(isPiCodeModel(ref(PI_MODEL_NEMOTRON))).toBe(true)
    // An unknown id resolves to no lane at all.
    expect(piLane(ref('nvidia/nemotron-3-nano-omni-30b-a3b:free'))).toBeUndefined()
  })

  it('pins each lane to a declared protocol and maps it to a real Pi provider api', () => {
    for (const model of PI_CODE_MODELS) {
      const protocol = piLaneProtocol(ref(model))
      expect(protocol).toBe('chat')
      expect(isPiProtocol(protocol)).toBe(true)
      expect(piApiForProtocol(protocol!)).toBe('openai-completions')
    }
    // A channel-qualified reference still resolves to the exact lane, not a merged id.
    expect(piLane(ref(`some-channel::${PI_MODEL_LFM}`))?.model).toBe(PI_MODEL_LFM)
    expect(piLaneProtocol(ref(`some-channel::${PI_MODEL_LFM}`))).toBe('chat')
  })

  it('refuses a protocol the official CLI has no provider api for', () => {
    expect(piApiForProtocol('chat')).toBe('openai-completions')
    expect(piApiForProtocol('responses')).toBe('openai-responses')
    expect(piApiForProtocol('messages')).toBe('anthropic-messages')
    // Never rounded to the nearest one, which would run a different route.
    expect(() => piApiForProtocol('grpc')).toThrow(/官方 Pi 不支持该协议/)
    expect(PI_PROTOCOLS).toEqual(['chat', 'responses', 'messages'])
  })

  it('declares reasoning per lane, which decides what the CLI advertises', () => {
    expect(piLaneReasoning(ref(PI_MODEL_NEMOTRON))).toBe(true)
    // Declaring reasoning where a model has none would advertise tiers it cannot serve.
    expect(piLaneReasoning(ref(PI_MODEL_LFM))).toBe(false)
    expect(piLaneReasoning(ref(PI_MODEL_INKLING))).toBe(false)
    expect(piLaneReasoning(ref('unknown:free'))).toBeUndefined()
  })

  it('never invents a reasoning tier the caller did not ask for', () => {
    expect(piThinkingValue(undefined)).toBeUndefined()
    expect(piThinkingValue('')).toBeUndefined()
    expect(piThinkingValue('   ')).toBeUndefined()
    expect(piThinkingValue('high')).toBe('high')
  })
})

describe('Pi config option reading', () => {
  const advertisement = [
    { id: 'model', currentValue: PI_MODEL_NEMOTRON, options: [{ value: PI_MODEL_NEMOTRON }] },
    { id: 'thinking', currentValue: 'high', options: [{ value: 'off' }, { value: 'high' }] },
  ]

  it('reads a pinned value out of an advertisement', () => {
    expect(piConfigOption(advertisement, 'model')).toEqual({
      currentValue: PI_MODEL_NEMOTRON,
      values: [PI_MODEL_NEMOTRON],
    })
    expect(piConfigOption(advertisement, 'thinking')?.values).toEqual(['off', 'high'])
  })

  it('treats a malformed advertisement as absent so pinning fails instead of passing', () => {
    expect(piConfigOption(undefined, 'model')).toBeUndefined()
    expect(piConfigOption('not-an-array', 'model')).toBeUndefined()
    expect(piConfigOption([null, 3, { id: 'other' }], 'model')).toBeUndefined()
    // An option with no usable values still counts as advertised, with an empty set.
    expect(piConfigOption([{ id: 'model' }], 'model')).toEqual({ currentValue: '', values: [] })
  })
})

describe('Pi session verification fails closed', () => {
  const adapter = createPiAdapter('bridge.mjs')
  const record = {
    id: 's1',
    combination: 'pi/nemotron',
    harnessRef: PI_HARNESS,
    modelRef: ref(PI_MODEL_NEMOTRON),
    cwd: process.cwd(),
    acpSessionId: '',
    origin: { kind: 'harness', sessionId: 's' },
    title: 't',
    sandbox: 'full-access',
    createdAt: '',
    updatedAt: '',
    turns: [],
  } as any

  it('accepts an advertisement that reports the pinned model', () => {
    expect(() =>
      adapter.verifySession!(record, {
        agent: {},
        session: {},
        configOptions: [
          { id: 'model', currentValue: PI_MODEL_NEMOTRON, options: [{ value: PI_MODEL_NEMOTRON }] },
        ],
      }),
    ).not.toThrow()
  })

  it('refuses a session whose model drifted, before any prompt is sent', () => {
    expect(() =>
      adapter.verifySession!(record, {
        agent: {},
        session: {},
        configOptions: [
          { id: 'model', currentValue: PI_MODEL_LFM, options: [{ value: PI_MODEL_LFM }] },
        ],
      }),
    ).toThrow(/与要求的 .* 不一致/)
  })

  it('refuses a requested tier the advertisement does not offer', async () => {
    await expect(
      adapter.configureSession!(
        {
          async request() {
            return {
              configOptions: [
                {
                  id: 'model',
                  currentValue: PI_MODEL_NEMOTRON,
                  options: [{ value: PI_MODEL_NEMOTRON }],
                },
                {
                  id: 'thinking',
                  currentValue: 'high',
                  options: [{ value: 'off' }, { value: 'high' }],
                },
              ],
            }
          },
        },
        { ...record, reasoningEffort: 'max' },
        {
          agent: {},
          session: { sessionId: 's1' },
          configOptions: [
            {
              id: 'model',
              currentValue: PI_MODEL_NEMOTRON,
              options: [{ value: PI_MODEL_NEMOTRON }],
            },
            {
              id: 'thinking',
              currentValue: 'high',
              options: [{ value: 'off' }, { value: 'high' }],
            },
          ],
        },
      ),
    ).rejects.toThrow(/不含所选取值 max/)
  })

  it('refuses when the advertisement omits the pinned model entirely', async () => {
    // Checked before any write, so a session that cannot prove its model never proceeds to
    // the reasoning tier at all.
    await expect(
      adapter.configureSession!(
        {
          async request() {
            return { configOptions: [] }
          },
        },
        record,
        {
          agent: {},
          session: { sessionId: 's1' },
          configOptions: [{ id: 'thinking', currentValue: 'off', options: [{ value: 'off' }] }],
        },
      ),
    ).rejects.toThrow(/未广告 model 配置项/)
  })

  it('refuses an unknown model instead of pinning something else', () => {
    expect(() =>
      adapter.verifySession!(
        { ...record, modelRef: ref('openai/gpt-oss-20b') },
        {
          agent: {},
          session: {},
          configOptions: [],
        },
      ),
    ).toThrow(/不属于官方 Pi 可固定的组合/)
  })
})
