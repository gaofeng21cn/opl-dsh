import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { Context } from '@deepseek-ai/cordis'
import { updateVolatile } from '@deepseek-ai/cosmokit'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as official from '@deepseek-ai/dsh-llm-pi-ai'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as providers from '../../src/compat/host/model-providers.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const keyring = vi.hoisted(() => ({
  describe: vi.fn(),
  read: vi.fn(),
  set: vi.fn(),
  remove: vi.fn(),
}))
vi.mock('../../src/credentials/host/windows-keyring.ts', () => ({ huaweiMaaSKeyring: keyring }))
beforeEach(() => {
  keyring.read.mockReset()
  keyring.read.mockResolvedValue(undefined)
})

describe('native Huawei provider profile', () => {
  it('exposes the native editor only after the Windows migration write finishes', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    const probe = Promise.withResolvers<string | undefined>()
    const writing = Promise.withResolvers<void>()
    const committed = Promise.withResolvers<void>()
    keyring.read.mockReturnValueOnce(probe.promise)
    const ctx = new Context()
    const home = await mkdtemp(join(tmpdir(), 'opl-native-migration-'))
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(LocalCredentialProvider, {
        path: join(home, '.credentials.yaml'),
        watch: false,
      })
      ctx.provide('settings', {
        configure: () => () => {},
        describe: () => [{ ns: 'llm-pi-ai', revision: 0 }],
        mutate: async (ns: string, ops: unknown, revision: number) => {
          expect(ns).toBe('llm-pi-ai')
          expect(ops).toEqual([
            { op: 'set', path: ['huaweiKeyringMigrated'], value: true },
            { op: 'set', path: ['huaweiCredentialsMigrated'], value: true },
          ])
          expect(revision).toBe(0)
          writing.resolve()
          await committed.promise
        },
      })
      const native = ctx.plugin(official, {})
      await native
      ctx.provide('loader', {
        entries: () => [
          {
            options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' },
            fiber: native.ctx.fiber,
          },
        ],
      })
      const adaptation = ctx.plugin(providers)
      await vi.waitFor(() => expect(keyring.read).toHaveBeenCalled())
      expect(
        ctx.llm.listConfigurableProviders().some((item) => item.provider === 'huawei-maas'),
      ).toBe(false)
      probe.resolve(undefined)
      await writing.promise
      expect(
        ctx.llm.listConfigurableProviders().some((item) => item.provider === 'huawei-maas'),
      ).toBe(false)
      committed.resolve()
      await adaptation
      expect(
        ctx.llm.listConfigurableProviders().some((item) => item.provider === 'huawei-maas'),
      ).toBe(true)
    } finally {
      committed.resolve()
      probe.resolve(undefined)
      await ctx.fiber.dispose()
      Object.defineProperty(process, 'platform', platform)
      await rm(home, { recursive: true, force: true })
    }
  })

  it.each([
    [{ huaweiKeyringMigrated: true, huaweiProviders: { 'huawei-maas': {} } }, true],
    [{ huaweiKeyringMigrated: true }, false],
    [{ huaweiCredentialsMigrated: true, huaweiProviders: { 'huawei-maas': {} } }, false],
  ])(
    'uses a separate credential migration marker and never revives deleted keys (%j)',
    async (raw, shouldRead) => {
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
      const ctx = new Context()
      const home = await mkdtemp(join(tmpdir(), 'opl-migration-marker-'))
      try {
        keyring.read.mockResolvedValue('synthetic-old-key')
        await ctx.plugin(LlmRuntime)
        await ctx.plugin(LocalCredentialProvider, {
          path: join(home, '.credentials.yaml'),
          watch: false,
        })
        ctx.provide('settings', {
          configure: () => () => {},
          describe: () => [{ ns: 'llm-pi-ai', revision: 0 }],
          mutate: async () => {},
        })
        // The old fields arrive in the original raw config before our extension is installed.
        const native = ctx.plugin(official, raw)
        await native
        ctx.provide('loader', {
          entries: () => [
            {
              options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' },
              fiber: native.ctx.fiber,
            },
          ],
        })
        await ctx.plugin(providers)
        expect(keyring.read.mock.calls.length > 0).toBe(shouldRead)
        expect((await ctx.credentials.resolve(credentialRef('HUAWEI_MAAS_API_KEY')))?.value).toBe(
          shouldRead ? 'synthetic-old-key' : undefined,
        )
      } finally {
        await ctx.fiber.dispose()
        Object.defineProperty(process, 'platform', platform)
        await rm(home, { recursive: true, force: true })
      }
    },
  )
  it('extends the existing official owner, responds to native volatile changes and restores the schema on unload', async () => {
    const ctx = new Context()
    const home = await mkdtemp(join(tmpdir(), 'opl-native-provider-'))
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LocalCredentialProvider, {
      path: join(home, '.credentials.yaml'),
      watch: false,
    })
    ctx.provide('settings', {
      configure: () => () => {},
      describe: () => [{ ns: 'llm-pi-ai', revision: 0 }],
      mutate: async () => {},
    })
    const native = ctx.plugin(official, {})
    await native
    const entry = {
      options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: {} },
      fiber: native.ctx.fiber,
    }
    ctx.provide('loader', { entries: () => [entry] })
    const schema = entry.fiber.runtime.Config as typeof official.Config
    const before = schema.dict?.huaweiProviders
    const discoveryBefore = Object.getOwnPropertyDescriptor(ctx.llm, 'discoverModels')
    try {
      await expect(
        ctx.llm.discoverModels('llm-pi-ai', { provider: 'huawei-maas' }),
      ).rejects.toThrow('pi-ai ships no catalog')
      const adaptation = ctx.plugin(providers)
      await adaptation
      const migrationReads = keyring.read.mock.calls.length
      const fetch = vi.spyOn(globalThis, 'fetch')
      try {
        expect(await ctx.llm.discoverModels('llm-pi-ai', { provider: 'huawei-maas' })).toEqual([
          { id: 'glm-5.2', name: 'GLM-5.2' },
        ])
        expect(
          await ctx.llm.remoteDiscoverModels(
            'llm-pi-ai',
            { provider: 'huawei-maas' },
            new AbortController().signal,
          ),
        ).toEqual([{ id: 'glm-5.2', name: 'GLM-5.2' }])
        expect(await ctx.llm.discoverModels('llm-pi-ai', { provider: 'openai' })).not.toHaveLength(
          0,
        )
        await expect(
          ctx.llm.discoverModels('llm-deepseek', { provider: 'huawei-maas' }),
        ).rejects.toThrow('no model discovery is registered')
        const aborted = AbortSignal.abort()
        await expect(
          ctx.llm.discoverModels('llm-pi-ai', { provider: 'huawei-maas' }, aborted),
        ).rejects.toMatchObject({ name: 'AbortError' })
        expect(fetch).not.toHaveBeenCalled()
        expect(keyring.read).toHaveBeenCalledTimes(migrationReads)
      } finally {
        fetch.mockRestore()
      }
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
      expect(Object.getOwnPropertyDescriptor(ctx.llm, 'discoverModels')).toEqual(discoveryBefore)
      await expect(
        ctx.llm.discoverModels('llm-pi-ai', { provider: 'huawei-maas' }),
      ).rejects.toThrow('pi-ai ships no catalog')
      expect(schema.dict?.huaweiProviders).toBe(before)
      expect(entry.options.name).toBe('@deepseek-ai/dsh-llm-pi-ai')
    } finally {
      await ctx.fiber.dispose()
      await rm(home, { recursive: true, force: true })
    }
  })
})
