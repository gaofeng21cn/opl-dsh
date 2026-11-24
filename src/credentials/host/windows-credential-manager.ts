/**
 * The Windows Credential Manager transport.
 *
 * Uses the prebuilt native N-API binding `@napi-rs/keyring` (`AsyncEntry.withTarget`)
 * to call Windows Credential Manager (`CredReadW` / `CredWriteW` / `CredDeleteW`)
 * directly in-process without spawning `powershell.exe` or compiling C# via `Add-Type`.
 *
 * Security and compatibility invariants:
 *
 * - Exact target names under {@link KEYRING_TARGET_PREFIX} are passed verbatim to
 *   WinCred `CRED_TYPE_GENERIC` via `AsyncEntry.withTarget`.
 * - Values are stored and read as UTF-16LE bytes (`setSecret` / `getSecret`), preserving
 *   byte-for-byte compatibility with credentials written by earlier releases.
 * - No child process is spawned, so the value never touches argv, environment, or disk.
 * - Credential enumeration is never exposed or invoked.
 * - Errors carry a `KeyringFailureCode` with any secret value redacted. No path falls
 *   back to a credential file or a `.env`.
 *
 * @module @one-person-lab/dsh-opl/credentials/windows-credential-manager
 */

import {
  KeyringError,
  KEYRING_TARGET_PREFIX,
  MAX_KEYRING_BLOB_BYTES,
  MAX_KEYRING_TARGET_LENGTH,
  type KeyringFailureCode,
} from '../contracts/windows-keyring.ts'

/** Default budget for one native keyring operation. */
const DEFAULT_TIMEOUT_MS = 15_000

/** Minimal surface required from `@napi-rs/keyring` `AsyncEntry`. */
export interface KeyringAsyncEntry {
  setSecret(secret: Uint8Array, signal?: AbortSignal | null): Promise<void>
  getSecret(signal?: AbortSignal | null): Promise<Array<number> | Uint8Array | null>
  deleteCredential(signal?: AbortSignal | null): Promise<boolean>
}

/** Minimal module shape loaded from `@napi-rs/keyring`. */
export interface KeyringModule {
  readonly AsyncEntry: {
    withTarget(target: string, service: string, username: string): KeyringAsyncEntry
  }
}

/** Per-call knobs. Present for tests; production callers need none. */
export interface WincredBridgeOptions {
  /** Budget for one operation. */
  readonly timeoutMs?: number
  /** Preserved for call-site compatibility; native N-API does not spawn a helper process. */
  readonly env?: NodeJS.ProcessEnv
  /** Optional module loader override for cross-platform unit tests. */
  readonly loadKeyring?: () => Promise<KeyringModule>
}

/** Replace any occurrence of the value in a diagnostic, and bound its length. */
function redact(secret: string | undefined, text: string): string {
  const trimmed = text.trim()
  if (secret === undefined || secret === '') return trimmed.slice(0, 400)
  return trimmed.split(secret).join('[redacted]').slice(0, 400)
}

/** Refuse a target outside {@link KEYRING_TARGET_PREFIX}. */
function assertTarget(target: string): void {
  if (typeof target !== 'string' || target === '') {
    throw new KeyringError('unavailable-target', 'A keyring target name is required')
  }
  if (target.length > MAX_KEYRING_TARGET_LENGTH) {
    throw new KeyringError(
      'unavailable-target',
      `Keyring target name exceeds ${MAX_KEYRING_TARGET_LENGTH} characters`,
    )
  }
  if (!target.startsWith(KEYRING_TARGET_PREFIX)) {
    throw new KeyringError(
      'unavailable-target',
      'Refusing to touch a credential outside the prefix this suite reserves',
    )
  }
}

/**
 * {@link assertTarget}, exported so the scope guard is testable on a host with
 * no Credential Manager.
 * @throws KeyringError when the name is not one this suite owns.
 */
export function assertKeyringTarget(target: string): void {
  assertTarget(target)
}

/**
 * @throws KeyringError `unsupported-platform` off Windows. There is no branch
 * that answers from `credentials.yml` or a `.env`.
 */
export function assertKeyringPlatform(platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'win32') {
    throw new KeyringError(
      'unsupported-platform',
      'Windows Credential Manager storage is only available on Windows',
    )
  }
}

/** Whether a host has a Windows Credential Manager at all. */
export function keyringSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32'
}

let cachedModule: Promise<KeyringModule> | undefined

async function loadNativeKeyring(options: WincredBridgeOptions): Promise<KeyringModule> {
  if (options.loadKeyring) {
    try {
      return await options.loadKeyring()
    } catch (cause) {
      throw new KeyringError(
        'helper-unavailable',
        'Windows Credential Manager native binding (@napi-rs/keyring) could not be loaded',
        { cause },
      )
    }
  }
  if (!cachedModule) {
    cachedModule = import('@napi-rs/keyring').then((mod) => mod as unknown as KeyringModule)
  }
  try {
    return await cachedModule
  } catch (cause) {
    cachedModule = undefined
    throw new KeyringError(
      'helper-unavailable',
      'Windows Credential Manager native binding (@napi-rs/keyring) is unavailable',
      { cause },
    )
  }
}

function classifyNativeError(
  cause: unknown,
  secret: string | undefined,
  timedOut: boolean,
): KeyringError {
  if (cause instanceof KeyringError) return cause
  const raw = cause instanceof Error ? cause.message : String(cause)
  if (timedOut || (cause instanceof Error && cause.name === 'AbortError')) {
    return new KeyringError(
      'helper-unavailable',
      redact(secret, `Windows Credential Manager operation timed out: ${raw}`),
      { cause },
    )
  }
  let code: KeyringFailureCode = 'helper-failed'
  if (/no storage access|platform failure|not supported|cannot load|native binding/iu.test(raw)) {
    code = 'helper-unavailable'
  }
  return new KeyringError(
    code,
    redact(secret, `Windows Credential Manager refused the operation: ${raw}`),
    { cause },
  )
}

async function runKeyring<T>(
  target: string,
  secret: string | undefined,
  options: WincredBridgeOptions,
  operation: (entry: KeyringAsyncEntry, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  assertKeyringPlatform()
  assertTarget(target)
  const keyring = await loadNativeKeyring(options)
  const entry = keyring.AsyncEntry.withTarget(target, 'opl-dsh', target)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (timeoutMs <= 0) {
    throw new KeyringError(
      'helper-unavailable',
      redact(secret, `Windows Credential Manager did not answer within ${timeoutMs}ms`),
    )
  }
  const controller = new AbortController()
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
      reject(
        new KeyringError(
          'helper-unavailable',
          redact(secret, `Windows Credential Manager did not answer within ${timeoutMs}ms`),
        ),
      )
    }, timeoutMs)
  })
  try {
    return await Promise.race([operation(entry, controller.signal), timeoutPromise])
  } catch (cause) {
    throw classifyNativeError(cause, secret, timedOut)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Read the credential stored under `target`. */
export async function wincredRead(
  target: string,
  options: WincredBridgeOptions = {},
): Promise<string | undefined> {
  const bytes = await runKeyring(target, undefined, options, (entry, signal) =>
    entry.getSecret(signal),
  )
  if (bytes === null || bytes.length === 0) return undefined
  const value = Buffer.from(bytes).toString('utf16le')
  return value === '' ? undefined : value
}

/** Store `secret` under `target`, replacing whatever was there. */
export async function wincredWrite(
  target: string,
  secret: string,
  options: WincredBridgeOptions = {},
): Promise<void> {
  if (typeof secret !== 'string') {
    throw new KeyringError('invalid-value', 'A keyring value must be a string')
  }
  if (secret === '') {
    throw new KeyringError(
      'empty-value',
      'An empty value cannot be stored; delete the credential instead',
    )
  }
  if (secret.includes('\0')) {
    throw new KeyringError('invalid-value', 'A keyring value cannot contain a NUL character')
  }
  const bytes = Buffer.from(secret, 'utf16le')
  if (bytes.byteLength > MAX_KEYRING_BLOB_BYTES) {
    throw new KeyringError(
      'value-too-large',
      `A keyring value of ${bytes.byteLength} UTF-16 bytes exceeds the WinCred limit of ${MAX_KEYRING_BLOB_BYTES}`,
    )
  }
  await runKeyring(target, secret, options, (entry, signal) => entry.setSecret(bytes, signal))
}

/** Whether a credential exists, without returning its value. */
export async function wincredExists(
  target: string,
  options: WincredBridgeOptions = {},
): Promise<boolean> {
  const bytes = await runKeyring(target, undefined, options, (entry, signal) =>
    entry.getSecret(signal),
  )
  return bytes !== null
}

/** Remove a credential. Removing an absent one reports `false` and is a no-op. */
export async function wincredDelete(
  target: string,
  options: WincredBridgeOptions = {},
): Promise<boolean> {
  return runKeyring(target, undefined, options, (entry, signal) => entry.deleteCredential(signal))
}
