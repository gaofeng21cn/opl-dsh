/** Fixed suite credentials backed by Windows Credential Manager. */
import {
  BAMBOO_STARTLUX_KEYRING_TARGET,
  JEV_TYPESAFE_KEYRING_TARGET,
  WINDOWS_KEYRING_SOURCE,
  type KeyringCredentialInfo,
  type KeyringFailureCode,
} from '../contracts/windows-keyring.ts'
import {
  assertKeyringPlatform,
  keyringSupported,
  wincredDelete,
  wincredExists,
  wincredRead,
  wincredWrite,
  type WincredBridgeOptions,
} from './windows-credential-manager.ts'

/** A fixed OS-keyring credential owned by this suite. */
export interface SuiteKeyringCredential {
  readonly target: string
  readonly read: (options?: WincredBridgeOptions) => Promise<string | undefined>
  readonly set: (value: string, options?: WincredBridgeOptions) => Promise<void>
  readonly remove: (options?: WincredBridgeOptions) => Promise<boolean>
  readonly describe: (options?: WincredBridgeOptions) => Promise<KeyringCredentialInfo>
}

function fixedKeyring(target: string): SuiteKeyringCredential {
  return {
    target,
    read: async (options) => {
      assertKeyringPlatform()
      return wincredRead(target, options)
    },
    set: async (value, options) => {
      assertKeyringPlatform()
      return wincredWrite(target, value, options)
    },
    remove: async (options) => {
      assertKeyringPlatform()
      return wincredDelete(target, options)
    },
    describe: async (options) => {
      if (!keyringSupported()) {
        return {
          configured: false,
          source: WINDOWS_KEYRING_SOURCE,
          supported: false,
          available: false,
          failure: 'unsupported-platform',
        }
      }
      try {
        return {
          configured: await wincredExists(target, options),
          source: WINDOWS_KEYRING_SOURCE,
          supported: true,
          available: true,
        }
      } catch (cause) {
        return {
          configured: false,
          source: WINDOWS_KEYRING_SOURCE,
          supported: true,
          available: false,
          failure:
            cause instanceof Error && 'code' in cause
              ? (cause.code as KeyringFailureCode)
              : 'helper-failed',
        }
      }
    },
  }
}

/** Optional Gateway password stored for the current Windows user. */
export const gatewayLoginKeyring = fixedKeyring('OPLDSH:Gateway:RememberedLogin')

/** Bamboo StartLux API key backed only by Windows Credential Manager. */
export const bambooStartLuxKeyring = fixedKeyring(BAMBOO_STARTLUX_KEYRING_TARGET)

/** Personal Jev API key backed only by Windows Credential Manager. */
export const jevTypeSafeKeyring = fixedKeyring(JEV_TYPESAFE_KEYRING_TARGET)
