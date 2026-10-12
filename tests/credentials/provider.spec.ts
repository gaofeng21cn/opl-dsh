import { Context } from '@deepseek-ai/cordis'
import { credentialRef, credentialKey } from '@deepseek-ai/dsh-credentials'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, it, expect, vi } from 'vitest'
import { installHuaweiCredentialRouting } from '../../src/credentials/host/provider.ts'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
const keyring = vi.hoisted(() => ({
  read: vi.fn(),
  describe: vi.fn(),
  set: vi.fn(),
  remove: vi.fn(),
}))
vi.mock('../../src/credentials/host/windows-keyring.ts', () => ({ huaweiMaaSKeyring: keyring }))

describe('native credential routing', () => {
  it('keeps Huawei mutations in the OS store while delegating refs and records to the unmodified local provider', async () => {
    const home = await mkdtemp(join(tmpdir(), 'opl-provider-test-'))
    const ctx = new Context()
    let stored: string | undefined
    keyring.read.mockImplementation(async () => stored)
    keyring.describe.mockImplementation(async () => ({
      configured: stored !== undefined,
      source: 'windows-credential-manager',
      supported: true,
      available: true,
    }))
    keyring.set.mockImplementation(async (value: string) => {
      stored = value
    })
    keyring.remove.mockImplementation(async () => {
      stored = undefined
    })
    const updates: string[] = []
    ctx.on('credentials/reference-updated', (ref) => {
      updates.push(ref)
    })
    try {
      await ctx.plugin(LocalCredentialProvider, {
        path: join(home, '.credentials.yaml'),
        watch: false,
      })
      const routing = ctx.plugin({ inject: ['credentials'], apply: installHuaweiCredentialRouting })
      await routing
      const huawei = credentialRef('HUAWEI_MAAS_API_KEY')
      await ctx.credentials.set(huawei, 'synthetic-huawei-native-key')
      expect(await ctx.credentials.describe(huawei)).toEqual({
        configured: true,
        source: 'windows-credential-manager',
        writable: true,
      })
      expect(await ctx.credentials.resolve(huawei)).toEqual({
        value: 'synthetic-huawei-native-key',
        source: 'windows-credential-manager',
      })
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
      const bytes = await readFile(join(home, '.credentials.yaml'), 'utf8')
      expect(updates.filter((ref) => ref === 'OTHER_PROVIDER_API_KEY')).toHaveLength(1)
      expect(bytes).toContain('synthetic-other-key')
      expect(bytes).not.toContain('synthetic-huawei-native-key')
      expect(bytes).not.toContain('HUAWEI_MAAS_API_KEY')
      await ctx.credentials.unset(huawei)
      expect(await ctx.credentials.describe(huawei)).toEqual({ configured: false, writable: true })
      expect(updates.filter((ref) => ref === huawei)).toHaveLength(2)
      keyring.set.mockRejectedValueOnce(new Error('secret from diagnostic'))
      await expect(ctx.credentials.set(huawei, 'another-synthetic-key')).rejects.not.toThrow(
        'secret from diagnostic',
      )
      expect(updates.filter((ref) => ref === huawei)).toHaveLength(2)
      keyring.describe.mockResolvedValueOnce({
        configured: false,
        supported: false,
        available: false,
      })
      expect(await ctx.credentials.describe(huawei)).toEqual({ configured: false, writable: false })
      await routing.dispose()
      expect(await ctx.credentials.describe(huawei)).toEqual({ configured: false, writable: true })
    } finally {
      await ctx.fiber.dispose()
      await rm(home, { recursive: true, force: true })
    }
  })
})
