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
    keyring.huawei.read.mockResolvedValue(undefined)
    keyring.bamboo.read.mockResolvedValue(undefined)
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
})
