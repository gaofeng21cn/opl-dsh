import { Context } from '@deepseek-ai/cordis'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { jevTypeSafeKeyring } from '../../src/credentials/host/windows-keyring.ts'
import { installProviderKeyringOverlay } from '../../src/credentials/host/keyring-overlay.ts'

const keyring = vi.hoisted(() => ({
  bamboo: {
    target: 'OPLDSH:BambooStartLux:ApiKey',
    read: vi.fn(),
    set: vi.fn(),
    remove: vi.fn(),
    describe: vi.fn(),
  },
}))
vi.mock('../../src/credentials/host/windows-keyring.ts', () => ({
  jevTypeSafeKeyring: {
    read: vi.fn().mockResolvedValue(undefined),
    set: vi.fn(),
    remove: vi.fn(),
    describe: vi.fn().mockResolvedValue({
      configured: false,
      supported: true,
      available: true,
      source: 'windows-credential-manager',
    }),
  },
  bambooStartLuxKeyring: keyring.bamboo,
}))

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})

describe('provider keyring overlay', () => {
  it('moves existing Bamboo plaintext values to WinCred and removes the file entries', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    keyring.bamboo.read.mockResolvedValueOnce(undefined).mockResolvedValue('synthetic-bamboo-key')
    const home = await mkdtemp(join(tmpdir(), 'opl-keyring-overlay-'))
    const path = join(home, '.credentials.yaml')
    const ctx = new Context()
    try {
      await ctx.plugin(LocalCredentialProvider, { path, watch: false })
      await ctx.credentials.set(credentialRef('BAMBOO_STARTLUX_API_KEY'), 'synthetic-bamboo-key')
      const overlay = installProviderKeyringOverlay(ctx)
      await overlay.migratePlaintext()
      expect(keyring.bamboo.set).toHaveBeenCalledWith('synthetic-bamboo-key')
      await expect(readFile(path, 'utf8')).resolves.not.toContain('synthetic-bamboo-key')
      keyring.bamboo.read.mockResolvedValue('synthetic-bamboo-key')
      expect(
        (await ctx.credentials.resolve(credentialRef('BAMBOO_STARTLUX_API_KEY')))?.source,
      ).toBe('windows-keyring')
      overlay.dispose()
    } finally {
      await ctx.fiber.dispose()
      await rm(home, { recursive: true, force: true })
    }
  })

  // NTFS cannot supply the POSIX owner modes required by the macOS credential provider.
  it.skipIf(process.platform === 'win32')(
    'preserves the official credential service for unrelated references on macOS',
    async () => {
      Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
      const home = await mkdtemp(join(tmpdir(), 'opl-keyring-macos-'))
      const path = join(home, '.credentials.yaml')
      const ctx = new Context()
      try {
        await ctx.plugin(LocalCredentialProvider, { path, watch: false })
        const ref = credentialRef('CUSTOM_PROVIDER_API_KEY')
        await ctx.credentials.set(ref, 'synthetic-existing-key')
        const overlay = installProviderKeyringOverlay(ctx)
        await overlay.migratePlaintext()
        expect((await ctx.credentials.resolve(ref))?.value).toBe('synthetic-existing-key')
        await ctx.credentials.set(ref, 'synthetic-updated-key')
        expect((await ctx.credentials.resolve(ref))?.value).toBe('synthetic-updated-key')
        expect((await ctx.credentials.describe(ref)).writable).toBe(true)
        expect(keyring.bamboo.read).not.toHaveBeenCalled()
        expect(keyring.bamboo.set).not.toHaveBeenCalled()
        await ctx.credentials.unset(ref)
        expect(await readFile(path, 'utf8')).not.toContain('synthetic-updated-key')
        overlay.dispose()
      } finally {
        await ctx.fiber.dispose()
        await rm(home, { recursive: true, force: true })
      }
    },
  )

  it.each([undefined, 'synthetic-wrong-key'])(
    'retains the original plaintext when keyring readback is %s',
    async (readback) => {
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
      keyring.bamboo.read.mockReset()
      keyring.bamboo.read.mockResolvedValueOnce(undefined).mockResolvedValue(readback)
      const home = await mkdtemp(join(tmpdir(), 'opl-keyring-failed-migration-'))
      const path = join(home, '.credentials.yaml')
      const ctx = new Context()
      try {
        await ctx.plugin(LocalCredentialProvider, { path, watch: false })
        const ref = credentialRef('BAMBOO_STARTLUX_API_KEY')
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

  it('keeps the official environment fallback below a saved Windows key', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    vi.stubEnv('BAMBOO_STARTLUX_API_KEY', 'synthetic-environment-key')
    keyring.bamboo.read.mockReset().mockResolvedValue(undefined)
    keyring.bamboo.describe.mockResolvedValue({
      configured: false,
      supported: true,
      available: true,
      source: 'windows-credential-manager',
    })
    keyring.bamboo.set.mockImplementation(async (value) => {
      keyring.bamboo.read.mockResolvedValue(value)
    })
    keyring.bamboo.remove.mockImplementation(async () => {
      keyring.bamboo.read.mockResolvedValue(undefined)
      return true
    })
    const home = await mkdtemp(join(tmpdir(), 'opl-keyring-environment-'))
    const path = join(home, '.credentials.yaml')
    const ctx = new Context()
    try {
      await ctx.plugin(LocalCredentialProvider, { path, watch: false })
      const ref = credentialRef('BAMBOO_STARTLUX_API_KEY')
      const overlay = installProviderKeyringOverlay(ctx)
      expect((await ctx.credentials.resolve(ref))?.value).toBe('synthetic-environment-key')
      expect((await ctx.credentials.describe(ref)).source).toBe('env')
      await ctx.credentials.set(ref, 'synthetic-saved-key')
      expect((await ctx.credentials.resolve(ref))?.value).toBe('synthetic-saved-key')
      await ctx.credentials.unset(ref)
      expect((await ctx.credentials.resolve(ref))?.value).toBe('synthetic-environment-key')
      expect(await readFile(path, 'utf8').catch(() => '')).not.toContain('synthetic-saved-key')
      overlay.dispose()
    } finally {
      await ctx.fiber.dispose()
      await rm(home, { recursive: true, force: true })
    }
  })
})

it('stores personal Jev keys only in WinCred and does not fall back to plaintext or environment', async () => {
  const home = await mkdtemp(join(tmpdir(), 'opl-jev-keyring-'))
  const path = join(home, '.credentials.yaml')
  const ctx = new Context()
  const ref = credentialRef('TYPESAFE_JEV_API_KEY')
  try {
    await ctx.plugin(LocalCredentialProvider, { path, watch: false })
    await ctx.credentials.set(ref, 'synthetic-old-plaintext')
    vi.stubEnv('TYPESAFE_JEV_API_KEY', 'synthetic-env')
    const overlay = installProviderKeyringOverlay(ctx)
    expect(await ctx.credentials.resolve(ref)).toBeUndefined()
    expect((await ctx.credentials.describe(ref)).configured).toBe(false)
    await ctx.credentials.set(ref, 'synthetic-personal-key')
    expect(jevTypeSafeKeyring.set).toHaveBeenCalledWith('synthetic-personal-key')
    expect(await readFile(path, 'utf8')).not.toContain('synthetic-personal-key')
    vi.mocked(jevTypeSafeKeyring.read).mockResolvedValueOnce('synthetic-personal-key')
    expect(await ctx.credentials.resolve(ref)).toEqual({
      value: 'synthetic-personal-key',
      source: 'windows-keyring',
    })
    await ctx.credentials.unset(ref)
    expect(jevTypeSafeKeyring.remove).toHaveBeenCalled()
    expect(await ctx.credentials.resolve(ref)).toBeUndefined()
    overlay.dispose()
  } finally {
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
})
