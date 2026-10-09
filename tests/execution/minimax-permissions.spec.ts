import { describe, expect, it, vi } from 'vitest'
import type { HarnessAdapter } from '../../src/execution/host/adapters/types.ts'
import type { HarnessSession } from '../../src/execution/contracts/sessions.ts'
import { withMinimaxPermissions } from '../../src/execution/host/adapters/minimax-permissions.ts'

const options = (mode = 'auto', values = ['default', 'auto', 'bypassPermissions']) => [
  {
    id: 'permissionMode',
    type: 'select',
    currentValue: mode,
    options: values.map((value) => ({ value })),
  },
  { id: 'model', type: 'select', currentValue: 'selected', options: [{ value: 'selected' }] },
]
function setup(mode = 'auto') {
  const base: HarnessAdapter = {
    id: 'minimax-code',
    transport: 'acp',
    matches: () => true,
    available: async () => ({ available: true }),
    configureSession: vi.fn(async (_acp, _record, snapshot) => ({
      configOptions: snapshot.configOptions,
    })),
    verifySession: vi.fn(),
  }
  const record = { sandbox: 'full-access', acpSessionId: 'mvs-original' } as HarnessSession
  const snapshot = { agent: {}, session: {}, configOptions: options(mode) }
  const request = vi.fn(async () => ({ configOptions: options('bypassPermissions') }))
  return { base, adapter: withMinimaxPermissions(base), record, snapshot, request }
}
describe('MiniMax permissions follow authorized full access', () => {
  it('sets the advertised Full access mode and verifies readback before model prompt admission', async () => {
    const { adapter, record, snapshot, request, base } = setup()
    const result = await adapter.configureSession!({ request }, record, snapshot)
    expect(request).toHaveBeenCalledExactlyOnceWith('session/set_config_option', {
      sessionId: 'mvs-original',
      configId: 'permissionMode',
      value: 'bypassPermissions',
    })
    expect(base.verifySession).toHaveBeenCalledWith(record, {
      ...snapshot,
      configOptions: options('bypassPermissions'),
    })
    expect(result).toEqual({ configOptions: options('bypassPermissions') })
    expect(request.mock.calls.some(([method]) => method === 'session/prompt')).toBe(false)
  })
  it('keeps the already-selected Full access mode without a redundant mutation and rejects drift', async () => {
    const { adapter, record, snapshot, request } = setup('bypassPermissions')
    await adapter.configureSession!({ request }, record, snapshot)
    expect(request).not.toHaveBeenCalled()
    expect(() =>
      adapter.verifySession!(record, { ...snapshot, configOptions: options('auto') }),
    ).toThrow('权限')
    expect(() => adapter.verifySession!(record, snapshot)).not.toThrow()
  })
  it.each(['read-only', 'workspace'] as const)(
    'refuses %s without configuring the CLI',
    async (sandbox) => {
      const { adapter, record, snapshot, request, base } = setup()
      record.sandbox = sandbox
      await expect(adapter.configureSession!({ request }, record, snapshot)).rejects.toThrow(
        '明确授权',
      )
      expect(request).not.toHaveBeenCalled()
      expect(base.configureSession).not.toHaveBeenCalled()
    },
  )
  it.each([undefined, options('auto', ['default', 'auto'])])(
    'refuses missing Full access capability without mutating permissions',
    async (configOptions) => {
      const { adapter, record, snapshot, request } = setup()
      snapshot.configOptions = configOptions as typeof snapshot.configOptions
      await expect(adapter.configureSession!({ request }, record, snapshot)).rejects.toThrow(
        '未广告',
      )
      expect(request).not.toHaveBeenCalled()
    },
  )
  it('refuses a wrong readback and hides arbitrary provider diagnostics on refusal', async () => {
    const { adapter, record, snapshot, request } = setup()
    request.mockResolvedValueOnce({ configOptions: options('auto') })
    await expect(adapter.configureSession!({ request }, record, snapshot)).rejects.toThrow('未确认')
    request.mockRejectedValueOnce(Error('private-account-secret'))
    await expect(adapter.configureSession!({ request }, record, snapshot)).rejects.toThrow(
      'MiniMax 拒绝设置 Full access 权限模式，未发送任务。',
    )
  })
})
