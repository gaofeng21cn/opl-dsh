import { Context } from '@deepseek-ai/cordis'
import { credentialRef, credentialKey } from '@deepseek-ai/dsh-credentials'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { migrateHuaweiCredential } from '../../src/credentials/host/provider.ts'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
const keyring = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('../../src/credentials/host/windows-keyring.ts', () => ({ huaweiMaaSKeyring: keyring }))
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const huawei = credentialRef('HUAWEI_MAAS_API_KEY')
beforeEach(() => {
  keyring.read.mockReset()
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
})
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  vi.unstubAllEnvs()
})

async function withStore(run: (ctx: Context, path: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), 'opl-provider-test-'))
  const path = join(home, '.credentials.yaml')
  const ctx = new Context()
  try {
    await ctx.plugin(LocalCredentialProvider, { path, watch: false })
    await run(ctx, path)
  } finally {
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
}

describe('official Huawei credential owner', () => {
  it('imports the old Key, then native replacement, deletion and restart use the same store as other refs and records', async () => {
    await withStore(async (ctx, path) => {
      keyring.read.mockResolvedValue('synthetic-legacy-key')
      const updates: string[] = []
      ctx.on('credentials/reference-updated', (ref) => {
        updates.push(ref)
      })
      expect(await migrateHuaweiCredential(ctx, true)).toBe(true)
      expect((await ctx.credentials.resolve(huawei))?.value).toBe('synthetic-legacy-key')
      await ctx.credentials.set(huawei, 'synthetic-replaced-key')
      await ctx.credentials.set(credentialRef('OTHER_PROVIDER_API_KEY'), 'synthetic-other-key')
      const record = credentialKey('llm-pi-ai', 'test')
      await ctx.credentials.modifyRecord(record, async () => ({
        kind: 'grant',
        payload: { opaque: true },
      }))
      expect(await ctx.credentials.readRecord(record)).toEqual({
        kind: 'grant',
        payload: { opaque: true },
      })
      expect(await readFile(path, 'utf8')).toContain('synthetic-replaced-key')
      const restart = new Context()
      try {
        await restart.plugin(LocalCredentialProvider, { path, watch: false })
        expect((await restart.credentials.resolve(huawei))?.value).toBe('synthetic-replaced-key')
      } finally {
        await restart.fiber.dispose()
      }
      await ctx.credentials.unset(huawei)
      expect(await ctx.credentials.describe(huawei)).toEqual({ configured: false, writable: true })
      expect(updates.filter((ref) => ref === huawei)).toHaveLength(3)
      expect(keyring.read).toHaveBeenCalledTimes(1)
    })
  })
  it('keeps an existing official credential ahead of the legacy store', async () => {
    await withStore(async (ctx) => {
      await ctx.credentials.set(huawei, 'synthetic-current-key')
      expect(await migrateHuaweiCredential(ctx, true)).toBe(false)
      expect(keyring.read).not.toHaveBeenCalled()
      expect((await ctx.credentials.resolve(huawei))?.value).toBe('synthetic-current-key')
    })
  })

  it('keeps launch-environment credentials ahead of legacy storage and rejects shadowed writes', async () => {
    vi.stubEnv('HUAWEI_MAAS_API_KEY', 'synthetic-environment-key')
    await withStore(async (ctx) => {
      expect(await migrateHuaweiCredential(ctx, true)).toBe(false)
      expect(await ctx.credentials.describe(huawei)).toEqual({
        configured: true,
        source: 'env',
        writable: false,
      })
      await expect(ctx.credentials.set(huawei, 'another-key')).rejects.toThrow('read-only')
      expect(keyring.read).not.toHaveBeenCalled()
    })
  })
  it('never imports a removed provider or touches WinCred on macOS', async () => {
    await withStore(async (ctx) => {
      expect(await migrateHuaweiCredential(ctx, false)).toBe(false)
      Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
      expect(await migrateHuaweiCredential(ctx, true)).toBe(false)
      await ctx.credentials.set(huawei, 'synthetic-mac-key')
      expect((await ctx.credentials.resolve(huawei))?.value).toBe('synthetic-mac-key')
      expect(keyring.read).not.toHaveBeenCalled()
    })
  })
  it('preserves the legacy source and hides diagnostics if reading or saving fails', async () => {
    await withStore(async (ctx) => {
      keyring.read.mockRejectedValueOnce(Error('secret diagnostic'))
      await expect(migrateHuaweiCredential(ctx, true)).rejects.toThrow('原凭据已保留')
      keyring.read.mockResolvedValue('synthetic-legacy-key')
      const write = vi
        .spyOn(ctx.credentials, 'set')
        .mockRejectedValueOnce(Error('secret diagnostic'))
      await expect(migrateHuaweiCredential(ctx, true)).rejects.not.toThrow('secret diagnostic')
      write.mockRestore()
      expect(await migrateHuaweiCredential(ctx, true)).toBe(true)
    })
  })
})
