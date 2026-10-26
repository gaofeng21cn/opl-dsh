import { describe, it, expect, vi } from 'vitest'
import { defaultHarness, adapterFor } from '../../src/execution/host/adapters/index.ts'
import { createHuaweiNativeAdapter } from '../../src/execution/host/adapters/huawei-native.ts'
import {
  HuaweiZcodeModelAdapter,
  HUAWEI_MODELS,
} from '../../src/execution/host/adapters/zcode-models.ts'
import { startKimiErrorRelay } from '../../src/execution/host/adapters/kimi/kimi-error-relay.ts'

describe('Huawei verified model routes', () => {
  it.each([
    ['deepseek-v4-flash', 'dsh'],
    ['kimi-k2.6', 'kimi-code'],
  ])('pairs %s with %s', (model, harness) => {
    const ref = { provider: 'huawei-maas', model }
    expect(defaultHarness(ref)).toBe(harness)
    expect(adapterFor(harness, ref)).toBeDefined()
  })
  it('keeps denied and unknown IDs out of the catalog', async () => {
    const adapter = new HuaweiZcodeModelAdapter()
    for (const model of ['glm-5.3', 'deepseek-v4.1-flash', 'deepseek-v4-pro']) {
      await expect(adapter.resolveModel('huawei-maas', model)).rejects.toThrow()
    }
  })
  it('uses the official native adapter only for DeepSeek and requires credentials before requests', async () => {
    const native = createHuaweiNativeAdapter(async () => undefined)
    const adapter = new HuaweiZcodeModelAdapter(() => HUAWEI_MODELS, native)
    const nativeCall = await adapter.prepareCall('huawei-maas', 'deepseek-v4-flash')
    await expect(async () => {
      for await (const _chunk of nativeCall.stream({
        provider: 'huawei-maas',
        model: 'deepseek-v4-flash',
        messages: [],
      })) {
      }
    }).rejects.toThrow('API Key')
    const prepared = await adapter.prepareCall('huawei-maas', 'kimi-k2.6')
    await expect(async () => {
      for await (const _chunk of prepared.stream({
        provider: 'huawei-maas',
        model: 'kimi-k2.6',
        messages: [],
      })) {
        /* no native fallback */
      }
    }).rejects.toThrow('执行组合')
  })
  it('passes keyring auth through the official model collection before streaming', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        'data: ' +
          JSON.stringify({
            id: 'fixture',
            choices: [
              { index: 0, delta: { role: 'assistant', content: 'DONE' }, finish_reason: null },
            ],
          }) +
          '\n\n' +
          'data: ' +
          JSON.stringify({
            id: 'fixture',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          }) +
          '\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    )
    try {
      const adapter = createHuaweiNativeAdapter(async () => 'synthetic-key')
      const chunks = []
      for await (const chunk of adapter.stream({
        provider: 'huawei-maas',
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Say DONE' }] }],
      }))
        chunks.push(chunk)
      expect(fetch).toHaveBeenCalledOnce()
      expect(chunks).toContainEqual(
        expect.objectContaining({ type: 'finish', reason: { kind: 'stop' } }),
      )
      expect(chunks).toContainEqual(expect.objectContaining({ type: 'text-delta', text: 'DONE' }))
    } finally {
      fetch.mockRestore()
    }
  })
  it('permits only the exact Huawei Kimi endpoint and model for remote forwarding', async () => {
    for (const baseURL of [
      'https://example.com/openai/v1',
      'https://api.modelarts-maas.com/other',
    ]) {
      await expect(
        startKimiErrorRelay({ baseURL, apiKey: 'fixture', model: 'kimi-k2.6' }),
      ).rejects.toThrow()
    }
    await expect(
      startKimiErrorRelay({
        baseURL: 'https://api.modelarts-maas.com/openai/v1',
        apiKey: 'fixture',
        model: 'other',
      }),
    ).rejects.toThrow()
    const relay = await startKimiErrorRelay({
      baseURL: 'https://api.modelarts-maas.com/openai/v1',
      apiKey: 'fixture',
      model: 'kimi-k2.6',
    })
    try {
      relay.begin()
      const response = await fetch(relay.baseURL + '/messages', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + relay.key },
        body: '{}',
      })
      expect(response.status).toBe(403)
    } finally {
      await relay.close()
    }
  })
})
