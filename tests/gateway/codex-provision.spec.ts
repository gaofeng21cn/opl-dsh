import { expect, it, vi } from 'vitest'
import { withCodexGatewayKey, codexGatewayKeyName } from '../../src/gateway/host/codex-provision.ts'
import {
  GatewayControlError,
  type GatewayManagedKey,
} from '../../src/gateway/host/gateway-control.ts'

const name = codexGatewayKeyName('windows', '')
const active = { id: '44', name, groupId: '9', key: 'sk-fixture-only', status: 'active', raw: {} }
function fixture(initial: GatewayManagedKey[] = []) {
  const db = [...initial]
  return {
    keys: vi.fn(async () => db),
    createKey: vi.fn(async () => {
      db.push(active)
      return active
    }),
    deactivateKey: vi.fn(async (_token: string, _id: string) => {}),
  }
}
it('issues only after preflight and reuses the dedicated key on a second run', async () => {
  const control = fixture()
  await expect(
    withCodexGatewayKey(control, 'token', '9', name, async () => {
      throw Error('busy')
    }),
  ).rejects.toThrow('busy')
  expect(control.keys).not.toHaveBeenCalled()
  const configure = async (issue: () => Promise<string>) => {
    expect(await Promise.all([issue(), issue()])).toEqual([active.key, active.key])
  }
  await withCodexGatewayKey(control, 'token', '9', name, configure)
  await withCodexGatewayKey(control, 'token', '9', name, configure)
  expect(control.createKey).toHaveBeenCalledTimes(1)
  expect(codexGatewayKeyName('wsl', 'Ubuntu')).not.toEqual(name)
})
it('disables only a newly issued key after a local write failure', async () => {
  for (const existing of [true, false]) {
    const control = fixture(existing ? [active] : [])
    await expect(
      withCodexGatewayKey(control, 'token', '9', name, async (issue) => {
        await issue()
        throw Error('local failed')
      }),
    ).rejects.toThrow('local failed')
    if (existing) expect(control.deactivateKey).not.toHaveBeenCalled()
    else expect(control.deactivateKey).toHaveBeenCalledExactlyOnceWith('token', active.id)
  }
})
it('blocks malformed groups, masked keys, and ambiguous active keys', async () => {
  for (const [group, rows] of [
    ['unknown', []],
    ['9', [{ ...active, key: 'sk-****' }]],
    ['9', [active, active]],
    ['9', [{ ...active, groupId: '3' }]],
  ] as const) {
    const control = fixture([...rows])
    await expect(
      withCodexGatewayKey(control, 'token', group, name, async (issue) => {
        await issue()
      }),
    ).rejects.toThrow()
    expect(control.createKey).not.toHaveBeenCalled()
    expect(control.deactivateKey).not.toHaveBeenCalled()
  }
})
it('reports incomplete key cleanup separately', async () => {
  const control = fixture()
  control.deactivateKey.mockRejectedValueOnce(Error('sensitive upstream detail'))
  await expect(
    withCodexGatewayKey(control, 'token', '9', name, async (issue) => {
      await issue()
      throw Error('local failed')
    }),
  ).rejects.toThrow('未能确认已停用')
})

it('reconciles an uncertain create through the exact active key without retrying the write', async () => {
  const control = fixture()
  control.createKey.mockRejectedValueOnce(new GatewayControlError('network_timeout', 'timeout'))
  control.keys.mockResolvedValueOnce([]).mockResolvedValueOnce([active])
  await withCodexGatewayKey(control, 'token', '9', name, async (issue) => {
    expect(await issue()).toBe(active.key)
  })
  expect(control.createKey).toHaveBeenCalledTimes(1)
  expect(control.keys).toHaveBeenCalledTimes(2)
  expect(control.deactivateKey).not.toHaveBeenCalled()
})
