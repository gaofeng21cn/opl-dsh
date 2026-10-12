import { Context } from '@deepseek-ai/cordis'
import { updateVolatile } from '@deepseek-ai/cosmokit'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as official from '@deepseek-ai/dsh-llm-pi-ai'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { describe, it, expect } from 'vitest'
import * as providers from '../../src/compat/host/model-providers.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('native Huawei provider profile', () => {
  it('extends the existing official owner, responds to native volatile changes and restores the schema on unload', async () => {
    const ctx = new Context()
    const home = await mkdtemp(join(tmpdir(), 'opl-native-provider-'))
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LocalCredentialProvider, {
      path: join(home, '.credentials.yaml'),
      watch: false,
    })
    ctx.provide('settings', { configure: () => () => {}, describe: () => [] })
    const native = ctx.plugin(official, {})
    await native
    const entry = {
      options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: {} },
      fiber: native.ctx.fiber,
    }
    ctx.provide('loader', { entries: () => [entry] })
    const schema = entry.fiber.runtime.Config as typeof official.Config
    const before = schema.dict?.huaweiProviders
    try {
      const adaptation = ctx.plugin(providers)
      await adaptation
      expect(
        ctx.llm.listConfigurableProviders().find((item) => item.provider === 'huawei-maas'),
      ).toMatchObject({ settingsNs: 'llm-pi-ai', settingsPath: ['huaweiProviders', 'huawei-maas'] })
      expect(ctx.llm.listProviders().some((item) => item.id === 'huawei-maas')).toBe(false)
      const active = entry.fiber.config as any
      expect(active.huaweiProviders.get()).toEqual({})
      const added = schema({ huaweiProviders: { 'huawei-maas': {} } }) as any
      expect(added.huaweiProviders.get()['huawei-maas'].apiKeyEnv).toBe('HUAWEI_MAAS_API_KEY')
      updateVolatile(active.huaweiProviders, added.huaweiProviders)
      ctx.emit('loader/volatile-update', [['huaweiProviders']])
      expect(await ctx.llm.listModels('huawei-maas')).toEqual([
        { provider: 'huawei-maas', id: 'glm-5.2', name: 'GLM-5.2' },
      ])
      expect(() =>
        schema({ huaweiProviders: { 'huawei-maas': { apiKeyEnv: 'UNSAFE_FILE_REF' } } }),
      ).toThrow()
      updateVolatile(active.huaweiProviders, (schema({}) as any).huaweiProviders)
      ctx.emit('loader/volatile-update', [['huaweiProviders']])
      expect(ctx.llm.listProviders().some((item) => item.id === 'huawei-maas')).toBe(false)
      await adaptation.dispose()
      expect(schema.dict?.huaweiProviders).toBe(before)
      expect(entry.options.name).toBe('@deepseek-ai/dsh-llm-pi-ai')
    } finally {
      await ctx.fiber.dispose()
      await rm(home, { recursive: true, force: true })
    }
  })
})
