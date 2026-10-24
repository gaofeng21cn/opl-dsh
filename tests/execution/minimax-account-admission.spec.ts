import { describe, expect, it, vi } from 'vitest'
import { HarnessService } from '../../src/execution/host/harness.ts'
import { RuntimeMaintenance } from '../../src/execution/host/runtime-maintenance.ts'

function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function owner(ready: Promise<void>, idle: () => Promise<void>) {
  const status = { installed: true, region: 'cn' as const, loginState: 'signed-out' as const, loginPending: false }
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
  })
  return { service, account }
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
    const entered = barrier(), idle = barrier()
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
})
