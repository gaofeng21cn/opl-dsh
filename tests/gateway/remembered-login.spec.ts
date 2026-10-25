import { expect, it, vi } from 'vitest'
import { GatewayPasswordStore } from '../../src/gateway/host/remembered-login.ts'
import type { SuiteKeyringCredential } from '../../src/credentials/host/windows-keyring.ts'
function fixture() {
  let value: string | undefined
  const keyring: SuiteKeyringCredential = {
    target: 'OPLDSH:Test:RememberedLogin',
    read: vi.fn(async () => value),
    set: vi.fn(async (next) => {
      value = next
    }),
    remove: vi.fn(async () => {
      value = undefined
      return true
    }),
    describe: vi.fn(async () => ({
      supported: true,
      available: true,
      configured: value !== undefined,
      source: 'windows-credential-manager',
    })),
  }
  return { store: new GatewayPasswordStore(keyring), keyring }
}
it('retains credentials in keyring but projects only the email', async () => {
  const { store, keyring } = fixture()
  await store.save('person@example.test', 'fixture-only-secret')
  expect(await store.describe()).toEqual({ supported: true, email: 'person@example.test' })
  expect(await store.password('person@example.test')).toBe('fixture-only-secret')
  await expect(store.password('another@example.test')).rejects.toThrow('没有保存密码')
  await store.clear()
  expect(keyring.remove).toHaveBeenCalledOnce()
  expect(await store.describe()).toEqual({ supported: true })
})
it('reports corrupt data without echoing it or falling back to a file', async () => {
  const { store, keyring } = fixture()
  await keyring.set('broken-fixture-secret')
  await expect(store.describe()).rejects.toThrow('保存的登录信息无效')
  await store.clear()
  expect(await store.describe()).toEqual({ supported: true })
})
