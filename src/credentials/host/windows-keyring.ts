/**
 * The Huawei MaaS keyring facade.
 *
 * Four operations over one fixed target, {@link HUAWEI_MAAS_KEYRING_TARGET}.
 * No operation names a target, and none enumerates the credential store, so a
 * caller cannot reach any credential other than this one.
 *
 * Storage is a `CRED_TYPE_GENERIC` credential written with
 * `CRED_PERSIST_LOCAL_MACHINE`: it survives restarts, is scoped to the calling
 * user on this machine, and is not visible to another user's logon session.
 * It is not isolation from the user: any process running as the same Windows
 * user can call Credential Manager and read the value. What this module adds is
 * that the value is not held in a file, in `argv`, in an environment variable,
 * or in a log.
 *
 * No operation falls back to `credentials.yml` or a `.env`. An unreachable
 * keyring is reported as an error.
 *
 * @module @one-person-lab/dsh-opl/credentials/huawei-maas-keyring
 */

import {
  HUAWEI_MAAS_KEYRING_TARGET,
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

/** The target this suite stores the Huawei MaaS key under. */
export { HUAWEI_MAAS_KEYRING_TARGET } from '../contracts/windows-keyring.ts'

/** Per-call knobs forwarded to the bridge. */
export type HuaweiMaaSKeyringOptions = WincredBridgeOptions

/**
 * Read the stored Huawei MaaS key.
 *
 * Resolves per call, so a replaced key reaches the next read without a
 * restart. The returned string lives only in the caller's memory; it is never
 * cached here and never placed in a snapshot, record, catalog, or log.
 * @returns the key, or `undefined` when none is stored.
 * @throws KeyringError with code `unsupported-platform` off Windows, or
 * `helper-unavailable` / `helper-failed` when the Credential Manager cannot be
 * reached. There is no non-keyring answer on this path.
 */
export async function readHuaweiMaaSApiKey(
  options?: HuaweiMaaSKeyringOptions,
): Promise<string | undefined> {
  assertKeyringPlatform()
  return wincredRead(HUAWEI_MAAS_KEYRING_TARGET, options)
}

/**
 * Store or replace the Huawei MaaS key.
 *
 * Replaces any existing credential at this target. The value reaches the OS
 * store over an anonymous pipe and is not written to disk by this module.
 * @param value - the non-empty key, at most 1280 UTF-16 code units.
 * @throws KeyringError with code `unsupported-platform`, `empty-value`,
 * `invalid-value`, `value-too-large`, or a helper failure code. Rejects rather
 * than throwing synchronously.
 */
export async function setHuaweiMaaSApiKey(
  value: string,
  options?: HuaweiMaaSKeyringOptions,
): Promise<void> {
  assertKeyringPlatform()
  return wincredWrite(HUAWEI_MAAS_KEYRING_TARGET, value, options)
}

/**
 * Remove the stored Huawei MaaS key.
 *
 * Removing an absent key succeeds and reports `false`.
 * @returns whether a credential was removed.
 * @throws KeyringError with code `unsupported-platform` or a helper failure
 * code.
 */
export async function deleteHuaweiMaaSApiKey(options?: HuaweiMaaSKeyringOptions): Promise<boolean> {
  assertKeyringPlatform()
  return wincredDelete(HUAWEI_MAAS_KEYRING_TARGET, options)
}

/**
 * Report whether a Huawei MaaS key is stored, without loading it.
 *
 * Calls `CredReadW` and discards the blob, so the value never crosses this
 * boundary. This is the only operation a settings surface should use.
 *
 * Does not throw when the keyring is unreachable: a page needs to show that the
 * keyring is broken, and `configured: false` with `available: false` and a
 * `failure` code is distinguishable from `configured: false, available: true`.
 * @returns presence, source, and availability; never the value.
 */
export async function describeHuaweiMaaSApiKey(
  options?: HuaweiMaaSKeyringOptions,
): Promise<KeyringCredentialInfo> {
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
    const configured = await wincredExists(HUAWEI_MAAS_KEYRING_TARGET, options)
    return {
      configured,
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
}

/** The same four operations as one object. */
export const huaweiMaaSKeyring = {
  read: readHuaweiMaaSApiKey,
  set: setHuaweiMaaSApiKey,
  remove: deleteHuaweiMaaSApiKey,
  describe: describeHuaweiMaaSApiKey,
} as const
