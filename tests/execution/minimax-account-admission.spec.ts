import { describe, expect, it, vi } from 'vitest'
import { HarnessService } from '../../src/execution/host/harness.ts'
import { RuntimeMaintenance } from '../../src/execution/host/runtime-maintenance.ts'
import type { MiniMaxAccountStatus } from '../../src/execution/contracts/minimax-account.ts'

function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function owner(ready: Promise<void>, idle: () => Promise<void>) {
  let enabled = true
  const status = {
    installed: true,
    region: 'cn' as const,
    loginState: 'signed-out' as const,
    loginPending: false,
  }
  const account = {
    status: vi.fn(async () => status),
    login: vi.fn(async () => status),
    cancel: vi.fn(async () => status),
    logout: vi.fn(async () => status),
  }
  // Exercise the service entry methods without constructing unrelated model registries.
  const service = Object.assign(Object.create(HarnessService.prototype) as HarnessService, {
    ready,
    assertNoGlobalActivity: idle,
    runtimeBusy: () => false,
    runtimeMaintenance: new RuntimeMaintenance(),
    minimaxAccount: account,
    minimaxCodeEnabledSource: () => enabled,
    minimaxIntegrationEnabled: true,
    events: { emit: vi.fn() },
  })
  return {
    service,
    account,
    async setEnabled(value: boolean) {
      enabled = value
      await service.synchronizeMiniMaxCodeIntegration()
    },
  }
}

describe('MiniMax account admission cancellation', () => {
  it('does not launch login after cancellation while service readiness is pending', async () => {
    const ready = barrier()
    const { service, account } = owner(ready.promise, async () => {})
    const login = service.minimaxAccountLogin({ region: 'cn' })
    await service.minimaxAccountCancel({ region: 'cn' })
    ready.resolve()
    await login
    expect(account.login).not.toHaveBeenCalled()
    expect(account.cancel).toHaveBeenCalledWith('cn')
  })

  it('cancellation bypasses maintenance and prevents login after a delayed idle check', async () => {
    const entered = barrier(),
      idle = barrier()
    const { service, account } = owner(Promise.resolve(), async () => {
      entered.resolve()
      await idle.promise
    })
    const login = service.minimaxAccountLogin({ region: 'cn' })
    await entered.promise
    await service.minimaxAccountCancel({ region: 'cn' })
    idle.resolve()
    await login
    expect(account.login).not.toHaveBeenCalled()
    await service.minimaxAccountLogout({ region: 'cn' })
    expect(account.logout).toHaveBeenCalledWith('cn')
  })

  it('keeps cooperative cancel available after opt-out while refusing new account operations', async () => {
    const { service, account, setEnabled } = owner(Promise.resolve(), async () => {})
    await setEnabled(false)
    expect(() => service.minimaxAccountStatus({ region: 'cn' })).toThrow(/已停用/)
    await expect(service.minimaxAccountLogin({ region: 'cn' })).rejects.toThrow(/已停用/)
    await expect(service.minimaxAccountLogout({ region: 'cn' })).rejects.toThrow(/已停用/)
    await expect(service.minimaxAccountCancel({ region: 'cn' })).resolves.toMatchObject({
      region: 'cn',
    })
    expect(account.cancel).toHaveBeenCalledWith('cn')
  })

  it('opt-out cancels an owned login while readiness is pending and never launches it', async () => {
    const ready = barrier()
    const { service, account, setEnabled } = owner(ready.promise, async () => {})
    const login = service.minimaxAccountLogin({ region: 'cn' })
    await setEnabled(false)
    ready.resolve()
    await login
    expect(account.cancel).toHaveBeenCalledExactlyOnceWith('cn')
    expect(account.login).not.toHaveBeenCalled()
  })

  it('opt-out cooperatively cancels an already running owned login', async () => {
    const pending = Promise.withResolvers<MiniMaxAccountStatus>()
    const { service, account, setEnabled } = owner(Promise.resolve(), async () => {})
    account.login.mockImplementationOnce(() => pending.promise)
    const login = service.minimaxAccountLogin({ region: 'cn' })
    await vi.waitFor(() => expect(account.login).toHaveBeenCalledOnce())
    await setEnabled(false)
    expect(account.cancel).toHaveBeenCalledExactlyOnceWith('cn')
    pending.resolve({
      installed: true,
      region: 'cn',
      loginState: 'signed-out',
      loginPending: false,
    })
    await login
  })
})
