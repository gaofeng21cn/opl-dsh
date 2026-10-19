import { Context } from '@deepseek-ai/cordis'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installProviderKeyringOverlay } from '../../src/credentials/host/keyring-overlay.ts'

const keyring = vi.hoisted(() => ({
  huawei: {
    target: 'OPLDSH:HuaweiMaaS:ApiKey',
    read: vi.fn(),
    set: vi.fn(),
    remove: vi.fn(),
    describe: vi.fn(),
  },
  bamboo: {
    target: 'OPLDSH:BambooStartLux:ApiKey',
    read: vi.fn(),
    set: vi.fn(),
    remove: vi.fn(),
    describe: vi.fn(),
  },
}))
vi.mock('../../src/credentials/host/windows-keyring.ts', () => ({
  huaweiMaaSKeyring: keyring.huawei,
  bambooStartLuxKeyring: keyring.bamboo,
}))

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  vi.clearAllMocks()
})

describe('provider keyring overlay', () => {
  it('moves existing Huawei and Bamboo plaintext values to WinCred and removes the file entries', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    keyring.huawei.read.mockResolvedValueOnce(undefined).mockResolvedValue('synthetic-huawei-key')
    keyring.bamboo.read.mockResolvedValueOnce(undefined).mockResolvedValue('synthetic-bamboo-key')
    const home = await mkdtemp(join(tmpdir(), 'opl-keyring-overlay-'))
    const path = join(home, '.credentials.yaml')
    const ctx = new Context()
    try {
      await ctx.plugin(LocalCredentialProvider, { path, watch: false })
      await ctx.credentials.set(credentialRef('HUAWEI_MAAS_API_KEY'), 'synthetic-huawei-key')
      await ctx.credentials.set(credentialRef('BAMBOO_STARTLUX_API_KEY'), 'synthetic-bamboo-key')
      const overlay = installProviderKeyringOverlay(ctx)
      await overlay.migratePlaintext()
      expect(keyring.huawei.set).toHaveBeenCalledWith('synthetic-huawei-key')
      expect(keyring.bamboo.set).toHaveBeenCalledWith('synthetic-bamboo-key')
      await expect(readFile(path, 'utf8')).resolves.not.toContain('synthetic-huawei-key')
      await expect(readFile(path, 'utf8')).resolves.not.toContain('synthetic-bamboo-key')
      keyring.huawei.read.mockResolvedValue('synthetic-huawei-key')
      expect((await ctx.credentials.resolve(credentialRef('HUAWEI_MAAS_API_KEY')))?.source).toBe(
        'windows-keyring',
      )
      overlay.dispose()
    } finally {
      await ctx.fiber.dispose()
      await rm(home, { recursive: true, force: true })
    }
  })

  it('preserves the official Huawei credential service on macOS', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
    const home = await mkdtemp(join(tmpdir(), 'opl-keyring-macos-'))
    const path = join(home, '.credentials.yaml')
    const ctx = new Context()
    try {
      await ctx.plugin(LocalCredentialProvider, { path, watch: false })
      const ref = credentialRef('HUAWEI_MAAS_API_KEY')
      await ctx.credentials.set(ref, 'synthetic-existing-key')
      const overlay = installProviderKeyringOverlay(ctx)
      await overlay.migratePlaintext()
      expect((await ctx.credentials.resolve(ref))?.value).toBe('synthetic-existing-key')
      await ctx.credentials.set(ref, 'synthetic-updated-key')
      expect((await ctx.credentials.resolve(ref))?.value).toBe('synthetic-updated-key')
      expect((await ctx.credentials.describe(ref)).writable).toBe(true)
      expect(keyring.huawei.read).not.toHaveBeenCalled()
      expect(keyring.huawei.set).not.toHaveBeenCalled()
      await ctx.credentials.unset(ref)
      expect(await readFile(path, 'utf8')).not.toContain('synthetic-updated-key')
      overlay.dispose()
    } finally {
      await ctx.fiber.dispose()
      await rm(home, { recursive: true, force: true })
    }
  })

  it.each([undefined, 'synthetic-wrong-key'])(
    'retains the original plaintext when keyring readback is %s',
    async (readback) => {
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
      keyring.huawei.read.mockReset()
      keyring.huawei.read.mockResolvedValueOnce(undefined).mockResolvedValue(readback)
      const home = await mkdtemp(join(tmpdir(), 'opl-keyring-failed-migration-'))
      const path = join(home, '.credentials.yaml')
      const ctx = new Context()
      try {
        await ctx.plugin(LocalCredentialProvider, { path, watch: false })
        const ref = credentialRef('HUAWEI_MAAS_API_KEY')
        await ctx.credentials.set(ref, 'synthetic-recoverable-key')
        const overlay = installProviderKeyringOverlay(ctx)
        await expect(overlay.migratePlaintext()).rejects.toThrow('original credential retained')
        expect(await readFile(path, 'utf8')).toContain('synthetic-recoverable-key')
        overlay.dispose()
      } finally {
        await ctx.fiber.dispose()
        await rm(home, { recursive: true, force: true })
      }
    },
  )
})
