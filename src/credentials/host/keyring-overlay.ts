/** Route selected provider API keys to the OS keyring instead of the file store. */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { BAMBOO_STARTLUX_CREDENTIAL_REF } from '../contracts/windows-keyring.ts'
import { HUAWEI_MAAS_CREDENTIAL_REF } from '../contracts/huawei-maas.ts'
import {
  bambooStartLuxKeyring,
  huaweiMaaSKeyring,
  type SuiteKeyringCredential,
} from './windows-keyring.ts'

const TARGETS = new Map<string, SuiteKeyringCredential>([
  [HUAWEI_MAAS_CREDENTIAL_REF, huaweiMaaSKeyring],
  [BAMBOO_STARTLUX_CREDENTIAL_REF, bambooStartLuxKeyring],
])

/**
 * Install a narrow credential seam for the two provider keys owned by this
 * suite. The official local provider remains the owner for every other key;
 * on Windows these two references never fall back to its YAML document.
 * Huawei keeps the official provider on other platforms.
 *
 * @param ctx - Host context containing the official credential service.
 * @returns a disposer and the unwrapped methods used for one-time migration.
 */
export function installProviderKeyringOverlay(ctx: Context): {
  dispose: () => void
  migratePlaintext: () => Promise<void>
} {
  const credentials = ctx.credentials
  const original = {
    resolve: credentials.resolve.bind(credentials),
    describe: credentials.describe.bind(credentials),
    set: credentials.set.bind(credentials),
    unset: credentials.unset.bind(credentials),
  }
  const descriptorOf = (name: keyof typeof original) =>
    Object.getOwnPropertyDescriptor(credentials, name)
  const previous = {
    resolve: descriptorOf('resolve'),
    describe: descriptorOf('describe'),
    set: descriptorOf('set'),
    unset: descriptorOf('unset'),
  }
  const target = (ref: CredentialRef) => {
    if (String(ref) === HUAWEI_MAAS_CREDENTIAL_REF && process.platform !== 'win32') return undefined
    return TARGETS.get(String(ref))
  }
  const emit = (ref: CredentialRef): void => {
    try {
      ctx.emit('credentials/reference-updated', ref)
    } catch {
      // The durable keyring write has already committed; an observer cannot
      // make it appear failed or trigger a plaintext fallback.
    }
  }
  const resolve = async (ref: CredentialRef) => {
    if (process.env.OPL_QUALIFICATION_SKIP_PROVIDER_KEYRING === '1') return original.resolve(ref)
    const keyring = target(ref)
    if (!keyring) return original.resolve(ref)
    const value = await keyring.read()
    if (value !== undefined) return { value, source: 'windows-keyring' }
    const inherited = await original.resolve(ref)
    return inherited?.source === 'file' ? undefined : inherited
  }
  const describe = async (ref: CredentialRef) => {
    if (process.env.OPL_QUALIFICATION_SKIP_PROVIDER_KEYRING === '1') return original.describe(ref)
    const keyring = target(ref)
    if (!keyring) return original.describe(ref)
    const info = await keyring.describe()
    if (!info.configured) {
      const inherited = await original.describe(ref)
      if (inherited.configured && inherited.source !== 'file')
        return { ...inherited, writable: info.supported && info.available }
    }
    return {
      configured: info.configured,
      source: info.source,
      writable: info.supported && info.available,
    }
  }
  const set = async (ref: CredentialRef, value: string) => {
    if (process.env.OPL_QUALIFICATION_SKIP_PROVIDER_KEYRING === '1') return original.set(ref, value)
    const keyring = target(ref)
    if (!keyring) return original.set(ref, value)
    await keyring.set(value)
    emit(ref)
  }
  const unset = async (ref: CredentialRef) => {
    if (process.env.OPL_QUALIFICATION_SKIP_PROVIDER_KEYRING === '1') return original.unset(ref)
    const keyring = target(ref)
    if (!keyring) return original.unset(ref)
    await keyring.remove()
    emit(ref)
  }
  Object.defineProperty(credentials, 'resolve', {
    configurable: true,
    writable: true,
    value: resolve,
  })
  Object.defineProperty(credentials, 'describe', {
    configurable: true,
    writable: true,
    value: describe,
  })
  Object.defineProperty(credentials, 'set', { configurable: true, writable: true, value: set })
  Object.defineProperty(credentials, 'unset', { configurable: true, writable: true, value: unset })
  return {
    dispose: () => {
      for (const name of Object.keys(previous) as (keyof typeof previous)[]) {
        const current = Object.getOwnPropertyDescriptor(credentials, name)
        const installed = { resolve, describe, set, unset }[name]
        if (current?.value !== installed) continue
        const old = previous[name]
        if (old) Object.defineProperty(credentials, name, old)
        else Reflect.deleteProperty(credentials, name)
      }
    },
    migratePlaintext: async () => {
      if (
        process.platform !== 'win32' ||
        process.env.OPL_QUALIFICATION_SKIP_PROVIDER_KEYRING === '1'
      )
        return
      for (const [raw, keyring] of TARGETS) {
        const ref = credentialRef(raw)
        const stored = await keyring.read()
        const description = await original.describe(ref)
        if (description.source !== 'file') continue
        const plaintext = await original.resolve(ref)
        if (stored === undefined && plaintext?.value) {
          await keyring.set(plaintext.value)
          if ((await keyring.read()) !== plaintext.value)
            throw new Error(
              'Provider keyring migration readback failed; original credential retained',
            )
        }
        if (plaintext?.value) await original.unset(ref)
      }
    },
  }
}
