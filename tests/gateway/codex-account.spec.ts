import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { testPeer } from '../test-peer.ts'
import { OplGatewayAccountService } from '../../src/gateway/host/account-service.ts'
import { GatewayControlClient } from '../../src/gateway/host/gateway-control.ts'
import { configureNativeCodex } from '../../src/gateway/host/codex-native.ts'
import { writeSession } from '../../src/gateway/host/session-store.ts'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../../src/gateway/host/codex-native.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/gateway/host/codex-native.ts')>()),
  configureNativeCodex: vi.fn(),
}))
const owners: Context[] = []
const dirs: string[] = []
afterEach(async () => {
  vi.clearAllMocks()
  for (const ctx of owners.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
async function setup() {
  const ctx = new Context()
  owners.push(ctx)
  const dir = await mkdtemp(join(tmpdir(), 'opl-codex-account-'))
  dirs.push(dir)
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, 'fixture.yaml'), watch: false })
  await writeSession(ctx.credentials, 'fake-refresh')
  const control = Object.assign(new GatewayControlClient(), {
    refreshSession: vi.fn(async () => ({
      accessToken: 'fresh-access',
      refreshToken: 'rotated-refresh',
    })),
    groups: vi.fn(async () => [{ id: '7', label: 'Codex' }]),
    keys: vi.fn(async () => []),
    createKey: vi.fn(async (_: string, name: string, groupId: string) => ({
      id: '8',
      name,
      groupId,
      status: 'active',
      key: 'sk-isolated-fixture',
      raw: {},
    })),
  })
  const account = new OplGatewayAccountService(ctx, {
    control,
    credentialRef: () => credentialRef('FIXTURE'),
    endpoint: () => 'https://fixture.invalid/v1',
  })
  const request: RemoteInvocation = {
    request: { namespace: 'oplGatewayAccount', method: 'configureCodex', args: {} },
    service: 'oplGatewayAccount',
    peer: testPeer,
    signal: testPeer.signal,
    uplink: async function* () {},
  }
  const owner = ctx.extend({ invocation: request }).get('oplGatewayAccount')!
  return { owner, account, control }
}
it('denies calls without owner identity before using the account or starting local setup', async () => {
  const { account, control } = await setup()
  await expect(account.configureCodex('windows', '', false)).rejects.toThrow('所有者')
  expect(control.refreshSession).not.toHaveBeenCalled()
  expect(configureNativeCodex).not.toHaveBeenCalled()
})
it.skipIf(process.platform !== 'win32' && process.platform !== 'darwin')(
  'uses the signed-in account and passes only the Codex-group dedicated key to the native target',
  async () => {
    const { owner, control } = await setup()
    vi.mocked(configureNativeCodex).mockImplementationOnce(async (issue) => {
      expect(await issue()).toBe('sk-isolated-fixture')
    })
    const target = process.platform === 'win32' ? 'windows' : 'mac'
    const result = await owner.configureCodex(target, '', false)
    expect(result).toMatchObject({ configured: true, needsInstall: false })
    expect(control.refreshSession).toHaveBeenCalledExactlyOnceWith('fake-refresh')
    expect(control.createKey).toHaveBeenCalledExactlyOnceWith(
      'fresh-access',
      expect.stringMatching(/^OPL Codex · /),
      '7',
    )
    expect(JSON.stringify(result)).not.toContain('sk-isolated')
  },
)
