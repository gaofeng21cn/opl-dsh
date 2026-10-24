import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { describe, it, expect, vi } from 'vitest'
vi.mock('../../src/execution/host/adapters/minimax.ts', () => ({
  minimaxCodePath: async () => 'mcode.exe',
}))
vi.mock('../../src/execution/host/minimax-account-state.ts', () => ({
  readMiniMaxAccountLoginState: async () => ({ loginState: 'signed-out' }),
}))
import { MiniMaxAccount } from '../../src/execution/host/minimax-account.ts'
class Child extends EventEmitter {
  pid = 42
  exitCode: number | null = null
  signalCode = null
  close() {
    this.exitCode = 0
    this.emit('close', 0, null)
  }
}
describe('account child ownership', () => {
  it('disposal rejects when its live login process cannot be stopped', async () => {
    const child = new Child()
    const spawn = vi.fn(() => child as unknown as ChildProcess)
    const fail = async () => {
      throw Error('denied')
    }
    const account = new MiniMaxAccount(async () => ({}), {
      spawn,
      stop: fail,
      forceStop: fail,
      stopGraceMs: 1,
    })
    const login = account.login('cn').catch(() => {})
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    try {
      await expect(account.dispose()).rejects.toThrow()
    } finally {
      child.close()
      await login
    }
  })
  it('a nonterminal process error does not release a running child', async () => {
    const child = new Child()
    const spawn = vi.fn(() => child as unknown as ChildProcess)
    const account = new MiniMaxAccount(async () => ({}), { spawn })
    const login = account.login('cn').catch(() => {})
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    child.emit('error', Error('kill EPERM'))
    await Promise.resolve()
    try {
      expect(await account.status('cn')).toMatchObject({ loginPending: true })
    } finally {
      child.close()
      await login
      await account.dispose()
    }
  })
})
