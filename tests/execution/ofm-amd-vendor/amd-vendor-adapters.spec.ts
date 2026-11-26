/** Exact EAC AMD routing, source identity and generated official CLI configuration. */
import { describe, expect, it } from 'vitest'
import { dshAdapter } from '../../../src/execution/host/adapters/dsh.ts'
import { adapterFor, automaticHarness } from '../../../src/execution/host/adapters/index.ts'

const OFM = 'our-free-model'
const DEEPSEEK_41 = 'amd/DeepSeek-V4.1-Flash'
const DEEPSEEK_4 = 'amd/DeepSeek-V4-Flash'

describe('EAC amd/ · DeepSeek 走原生 DSH', () => {
  it.each([DEEPSEEK_41, DEEPSEEK_4])('%s 由原生 DSH 承载', (model) => {
    // The native adapter owns the agent loop and selects the model from the Host's own
    // registry, so it claims the reference. No external adapter may claim it too.
    expect(dshAdapter.matches({ provider: OFM, model })).toBe(true)
    expect(automaticHarness({ provider: OFM, model })).toBe('dsh')
    for (const external of ['codex', 'claude', 'opencode', 'pi', 'kilo', 'kimi-code'])
      expect(adapterFor(external, { provider: OFM, model })).toBeUndefined()
  })

  it('不把同一台账上的别的模型或区域来源顺带认领', () => {
    expect(
      automaticHarness({ provider: OFM, model: 'amd/DeepSeek-V4.1-Flash-free' }),
    ).toBeUndefined()
    expect(
      automaticHarness({ provider: 'our-free-model-region', model: DEEPSEEK_41 }),
    ).toBeUndefined()
  })
})
