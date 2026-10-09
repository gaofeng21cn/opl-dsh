/**
 * Client-safe vocabulary for the Huawei MaaS keyring.
 *
 * Names one credential, its target, the failure codes a caller branches on, and
 * the UI-safe view. Types only: nothing here reaches a Host-only symbol, so a
 * settings surface compiles against this without the transport.
 *
 * Configuration carries the target name, never the value.
 *
 * @module @one-person-lab/dsh-opl/credentials/types
 */

/** Where a stored Huawei MaaS key lives. */
export const WINDOWS_KEYRING_SOURCE = 'windows-credential-manager'

/**
 * Target-name prefix reserved to this suite.
 *
 * A WinCred `CRED_TYPE_GENERIC` target must identify the owning service. The
 * prefix is what makes a delete scoped: a target without it is refused before
 * any WinCred call.
 */
export const KEYRING_TARGET_PREFIX = 'OPLDSH:'

/**
 * The one credential this suite stores: Huawei MaaS, for the GLM-5.2 route
 * and the official ZCode integration.
 *
 * WinCred matches target names case-insensitively.
 */
export const HUAWEI_MAAS_KEYRING_TARGET = 'OPLDSH:HuaweiMaaS:ApiKey'

/** `CRED_MAX_GENERIC_TARGET_NAME_LENGTH`. */
export const MAX_KEYRING_TARGET_LENGTH = 32767

/**
 * `CRED_MAX_CREDENTIAL_BLOB_SIZE`: 5 × 512 bytes.
 *
 * The value is stored as UTF-16LE, so this is 1280 code units.
 */
export const MAX_KEYRING_BLOB_BYTES = 5 * 512

/**
 * Why an operation failed.
 *
 * Every code is terminal. There is deliberately no code meaning "fall back to
 * a file": a caller that received a value from `credentials.yml` or a `.env`
 * would believe the key is in the OS credential store.
 */
export type KeyringFailureCode =
  /** This host is not Windows; the Credential Manager does not exist here. */
  | 'unsupported-platform'
  /** A target name outside {@link KEYRING_TARGET_PREFIX} was requested. */
  | 'unavailable-target'
  /** An empty value cannot be stored; delete the credential instead. */
  | 'empty-value'
  /** Not a string, or contains a NUL that cannot survive the blob. */
  | 'invalid-value'
  /** The value exceeds {@link MAX_KEYRING_BLOB_BYTES} once UTF-16 encoded. */
  | 'value-too-large'
  /** The helper could not start, or could not compile its P/Invoke. */
  | 'helper-unavailable'
  /** The helper ran and WinCred refused the operation. */
  | 'helper-failed'
  /** The helper answered something this backend cannot interpret. */
  | 'unexpected-response'

/**
 * A keyring failure carrying its code, never the value.
 *
 * `message` is composed from the code and a WinCred status, so an error that
 * reaches a log does not carry the key it was about to hold.
 */
export class KeyringError extends Error {
  readonly code: KeyringFailureCode
  constructor(code: KeyringFailureCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'KeyringError'
    this.code = code
  }
}

/**
 * Presence and availability, safe for a settings UI. Never the value.
 *
 * When the keyring cannot be reached, `available: false` with a `failure` code
 * separates "could not ask" from "asked, and no key is stored"; both report
 * `configured: false` and must not be rendered the same way.
 */
export interface KeyringCredentialInfo {
  /** Whether the Credential Manager currently holds this credential. */
  readonly configured: boolean
  /** Where the value lives when it does. */
  readonly source: typeof WINDOWS_KEYRING_SOURCE
  /** Whether this host has a Windows Credential Manager. */
  readonly supported: boolean
  /** Whether the keyring could be reached and asked. */
  readonly available: boolean
  /** Why it could not be reached, when it could not. */
  readonly failure?: KeyringFailureCode
}
