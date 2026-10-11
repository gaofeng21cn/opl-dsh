/**
 * Focused coverage for the Windows Credential Manager backend.
 *
 * Every test that writes uses a random, self-owned target from
 * {@link ownedTarget} and removes it in `finally` through
 * {@link cleanupOwnedTarget}, which asserts the target is gone and fails the
 * test if cleanup does not succeed. No test reads, writes, or deletes
 * {@link HUAWEI_MAAS_KEYRING_TARGET}, and nothing here enumerates the
 * credential store: the tests address only the target they created.
 *
 * Filesystem assertions stay inside a per-test directory the test created
 * ({@link exclusiveTempDir}), which is also what it points the helper's
 * TEMP/TMP at. Nothing outside that directory is read.
 *
 * Values are synthetic — random bytes with a recognisable prefix — so a failure
 * message can never carry a real key, and no assertion prints a value.
 */

import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  HUAWEI_MAAS_KEYRING_TARGET,
  KEYRING_TARGET_PREFIX,
  MAX_KEYRING_BLOB_BYTES,
  MAX_KEYRING_TARGET_LENGTH,
  WINDOWS_KEYRING_SOURCE,
} from '../../src/credentials/contracts/windows-keyring.ts'
import {
  assertKeyringPlatform,
  assertKeyringTarget,
  keyringSupported,
  wincredArgvScan,
  wincredDelete,
  wincredExists,
  wincredRead,
  wincredStructSize,
  wincredWrite,
} from '../../src/credentials/host/windows-credential-manager.ts'
import {
  describeHuaweiMaaSApiKey,
  huaweiMaaSKeyring,
  readHuaweiMaaSApiKey,
  setHuaweiMaaSApiKey,
} from '../../src/credentials/host/windows-keyring.ts'

const run = promisify(execFile)
const isWindows = process.platform === 'win32'

/**
 * Each helper round trip compiles a P/Invoke type, which takes hundreds of
 * milliseconds; a lifecycle test makes several. The default 5s budget is not a
 * meaningful ceiling for this.
 */
const WINDOWS_TEST_TIMEOUT = 120_000

/** A synthetic value no real key can equal. */
function synthetic(label: string): string {
  return `${label}-${randomBytes(12).toString('hex')}`
}

/** A target name this test run owns alone, so cleanup is unambiguous. */
function ownedTarget(label: string): string {
  return `${KEYRING_TARGET_PREFIX}SELFTEST-${label}-${randomBytes(8).toString('hex')}`
}

describe('keyring target scope', () => {
  it('accepts only names inside the prefix this suite reserves', () => {
    expect(() => assertKeyringTarget(HUAWEI_MAAS_KEYRING_TARGET)).not.toThrow()
    expect(() => assertKeyringTarget(`${KEYRING_TARGET_PREFIX}anything`)).not.toThrow()
  })

  it('refuses to touch a credential this suite does not own', () => {
    for (const foreign of [
      'Generic Credential',
      'Microsoft_RAS_VPN',
      'git:https://example.invalid',
      'SomeOtherSuite:Huawei:ApiKey',
      '',
      'OPLDSH',
    ]) {
      expect(() => assertKeyringTarget(foreign)).toThrowError(
        expect.objectContaining({ code: 'unavailable-target' }),
      )
    }
  })

  it('refuses an over-long target before any WinCred call', () => {
    expect(() =>
      assertKeyringTarget(`${KEYRING_TARGET_PREFIX}${'x'.repeat(MAX_KEYRING_TARGET_LENGTH)}`),
    ).toThrowError(expect.objectContaining({ code: 'unavailable-target' }))
  })

  it('exposes no operation that enumerates the credential store', () => {
    expect(Object.keys(huaweiMaaSKeyring).sort()).toEqual(['describe', 'read', 'remove', 'set'])
    for (const name of ['list', 'enumerate', 'entries', 'targets']) {
      expect(name in huaweiMaaSKeyring).toBe(false)
    }
  })
})

describe('value validation', () => {
  it('refuses an empty value, matching the seam rule that blank is absent', async () => {
    await expect(wincredWrite(HUAWEI_MAAS_KEYRING_TARGET, '')).rejects.toThrowError(
      expect.objectContaining({ code: 'empty-value' }),
    )
  })

  it('refuses a value that cannot survive the blob round trip', async () => {
    await expect(wincredWrite(HUAWEI_MAAS_KEYRING_TARGET, 'has\0null')).rejects.toThrowError(
      expect.objectContaining({ code: 'invalid-value' }),
    )
  })

  it('refuses a value beyond the WinCred blob limit', async () => {
    await expect(
      wincredWrite(HUAWEI_MAAS_KEYRING_TARGET, 'x'.repeat(MAX_KEYRING_BLOB_BYTES / 2 + 1)),
    ).rejects.toThrowError(expect.objectContaining({ code: 'value-too-large' }))
  })

  it('refuses a non-string value', async () => {
    await expect(
      wincredWrite(HUAWEI_MAAS_KEYRING_TARGET, undefined as unknown as string),
    ).rejects.toThrowError(expect.objectContaining({ code: 'invalid-value' }))
  })
})

describe('unsupported platforms', () => {
  it('reports support only for Windows', () => {
    expect(keyringSupported('win32')).toBe(true)
    expect(keyringSupported('darwin')).toBe(false)
    expect(keyringSupported('linux')).toBe(false)
  })

  it('fails loudly rather than pretending the keyring exists', () => {
    for (const platform of ['darwin', 'linux'] as NodeJS.Platform[]) {
      expect(() => assertKeyringPlatform(platform)).toThrowError(
        expect.objectContaining({ code: 'unsupported-platform' }),
      )
    }
  })

  it('rejects every value-carrying operation off Windows', async () => {
    await withPlatform('linux', async () => {
      await expect(readHuaweiMaaSApiKey()).rejects.toThrowError(
        expect.objectContaining({ code: 'unsupported-platform' }),
      )
      await expect(setHuaweiMaaSApiKey('anything')).rejects.toThrowError(
        expect.objectContaining({ code: 'unsupported-platform' }),
      )
      await expect(huaweiMaaSKeyring.remove()).rejects.toThrowError(
        expect.objectContaining({ code: 'unsupported-platform' }),
      )
    })
  })

  it('describes an absent keyring as unavailable, not as an unset key', async () => {
    await withPlatform('darwin', async () => {
      expect(await describeHuaweiMaaSApiKey()).toEqual({
        configured: false,
        source: WINDOWS_KEYRING_SOURCE,
        supported: false,
        available: false,
        failure: 'unsupported-platform',
      })
    })
  })
})

/**
 * Run `body` while the process reports a different platform.
 *
 * Stubbing the one global the backend reads keeps the "this host is not
 * Windows" behaviour under test on a Windows host, where every other case here
 * is exercised for real.
 */
async function withPlatform(platform: NodeJS.Platform, body: () => Promise<void>): Promise<void> {
  const real = process.platform
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    await body()
  } finally {
    Object.defineProperty(process, 'platform', { value: real, configurable: true })
  }
}

describe.skipIf(!isWindows)('windows credential manager', () => {
  it(
    'stores, reads back, replaces, and removes one credential',
    async () => {
      const target = ownedTarget('lifecycle')
      const first = synthetic('first')
      const second = synthetic('second')
      try {
        expect(await wincredExists(target)).toBe(false)
        expect(await wincredRead(target)).toBeUndefined()

        await wincredWrite(target, first)
        expect(await wincredExists(target)).toBe(true)
        expect(await wincredRead(target)).toBe(first)

        await wincredWrite(target, second)
        expect(await wincredRead(target)).toBe(second)
        expect(await wincredRead(target)).not.toBe(first)

        expect(await wincredDelete(target)).toBe(true)
        expect(await wincredExists(target)).toBe(false)
        expect(await wincredRead(target)).toBeUndefined()
      } finally {
        await cleanupOwnedTarget(target)
      }
    },
    WINDOWS_TEST_TIMEOUT,
  )

  it(
    'treats removing an absent credential as a no-op',
    async () => {
      const target = ownedTarget('absent-delete')
      try {
        expect(await wincredDelete(target)).toBe(false)
        expect(await wincredDelete(target)).toBe(false)
      } finally {
        await cleanupOwnedTarget(target)
      }
    },
    WINDOWS_TEST_TIMEOUT,
  )

  it(
    'round-trips unicode, newlines, and quoting exactly',
    async () => {
      const target = ownedTarget('unicode')
      const value = `${synthetic('u')}-中文-秘密-\nsecond\t"quoted"\\slash`
      try {
        await wincredWrite(target, value)
        expect(await wincredRead(target)).toBe(value)
      } finally {
        await cleanupOwnedTarget(target)
      }
    },
    WINDOWS_TEST_TIMEOUT,
  )

  it(
    'lets a separate OS process read what this one wrote',
    async () => {
      const target = ownedTarget('cross-process')
      const value = synthetic('cross')
      try {
        await wincredWrite(target, value)
        const { stdout } = await run(
          process.execPath,
          [join(import.meta.dirname, '..', 'fixtures', 'wincred-read-target.mjs'), target],
          { timeout: WINDOWS_TEST_TIMEOUT - 10_000 },
        )
        const report = JSON.parse(stdout.trim()) as {
          pid: number
          configured: boolean
          length: number
          sha256: string
        }
        expect(report.configured).toBe(true)
        expect(report.pid).not.toBe(process.pid)
        expect(report.length).toBe(value.length)
        expect(report.sha256).toBe(createHash('sha256').update(value).digest('hex'))
      } finally {
        await cleanupOwnedTarget(target)
      }
    },
    WINDOWS_TEST_TIMEOUT,
  )

  it(
    'marshals the documented CREDENTIAL size rather than a guessed one',
    async () => {
      // 80 bytes on x64, 52 on x86: the pointer fields take their natural
      // alignment, so a hardcoded offset table would be wrong on one of them.
      const size = await wincredStructSize()
      expect(size).toBe(process.arch === 'x64' ? 80 : 52)
    },
    WINDOWS_TEST_TIMEOUT,
  )

  it(
    'never puts the value in the helper argv or environment',
    async () => {
      const value = synthetic('argvscan')
      expect(await wincredArgvScan(value)).toEqual({ inArgv: false, inEnv: false })
    },
    WINDOWS_TEST_TIMEOUT,
  )

  it(
    'keeps the value out of an error when the helper does not answer',
    async () => {
      const value = 'distinctive-secret-that-must-never-be-echoed'
      const target = ownedTarget('timeout')
      try {
        const failure = await wincredWrite(target, value, { timeoutMs: 1 }).catch(
          (error: unknown) => error,
        )
        expect(failure).toBeInstanceOf(Error)
        expect((failure as { code?: string }).code).toBe('helper-unavailable')
        const rendered = [
          String((failure as Error).message),
          String((failure as Error).stack),
          JSON.stringify(failure, Object.getOwnPropertyNames(failure as object)),
        ].join('\n')
        expect(rendered).not.toContain(value)
      } finally {
        await cleanupOwnedTarget(target)
      }
    },
    WINDOWS_TEST_TIMEOUT,
  )

  it(
    'leaves no plaintext in the temporary directory it was given',
    async () => {
      // The helper is handed a TEMP/TMP of its own, so anything it might spill
      // to a temporary location lands here. Only this directory is read back.
      // The claim is exactly that — nothing this write produced reached this
      // directory — and reading wider would mean reading files this test does
      // not own.
      const value = synthetic('no-plaintext-on-disk')
      const target = ownedTarget('disk')
      const sandbox = exclusiveTempDir()
      const startedAt = Date.now()
      try {
        await wincredWrite(target, value, { env: helperEnvFor(sandbox) })
        expect(await wincredExists(target)).toBe(true)
        for (const file of filesChangedSince(sandbox, startedAt)) {
          expect(readFileSync(file, 'utf8'), file).not.toContain(value)
        }
      } finally {
        await cleanupOwnedTarget(target)
      }
    },
    WINDOWS_TEST_TIMEOUT,
  )

  it(
    'runs from any working directory, needing no built artifact on disk',
    async () => {
      // The helper program is embedded in the module rather than shipped beside
      // it, so there is no resource path for a build to get wrong. The cycle
      // runs against this run's own target, never the real Huawei MaaS key.
      const target = ownedTarget('cwd')
      const value = synthetic('cwd')
      const elsewhere = exclusiveTempDir()
      const original = process.cwd()
      try {
        process.chdir(elsewhere)
        await wincredWrite(target, value)
        expect(await wincredRead(target)).toBe(value)
        expect(await wincredDelete(target)).toBe(true)
      } finally {
        process.chdir(original)
        await cleanupOwnedTarget(target)
      }
    },
    WINDOWS_TEST_TIMEOUT,
  )

  it(
    'refuses an unowned target end to end, before reaching WinCred',
    async () => {
      await expect(
        wincredWrite('SomeOtherSuite:ApiKey', synthetic('foreign')),
      ).rejects.toThrowError(expect.objectContaining({ code: 'unavailable-target' }))
      await expect(wincredRead('SomeOtherSuite:ApiKey')).rejects.toThrowError(
        expect.objectContaining({ code: 'unavailable-target' }),
      )
    },
    WINDOWS_TEST_TIMEOUT,
  )
})

/**
 * Remove this run's own target and assert it is gone.
 *
 * A cleanup that fails must fail the test: swallowing it would let a run leave
 * a credential behind and still report success. Deleting an already-absent
 * target returns `false` without error, which is why the follow-up existence
 * check — not the delete's return value — is the assertion.
 *
 * Only ever call this with a target from {@link ownedTarget}. It must never be
 * given {@link HUAWEI_MAAS_KEYRING_TARGET}.
 */
async function cleanupOwnedTarget(target: string): Promise<void> {
  expect(
    target.startsWith(`${KEYRING_TARGET_PREFIX}SELFTEST-`),
    `refusing to clean ${target}`,
  ).toBe(true)
  await wincredDelete(target)
  expect(await wincredExists(target), `cleanup left ${target} behind`).toBe(false)
}

/** A temporary directory this test owns alone. */
function exclusiveTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'opl-keyring-'))
}

/**
 * The caller's environment with TEMP/TMP pointed at `directory`.
 *
 * The bridge trims this to its own allow-list before spawning, so the helper
 * keeps the system variables it needs and picks up only these two overrides.
 */
function helperEnvFor(directory: string): NodeJS.ProcessEnv {
  return { ...process.env, TEMP: directory, TMP: directory }
}

/** Files under `root`, and only `root`, modified at or after `since`. */
function filesChangedSince(root: string, since: number): string[] {
  const found: string[] = []
  const walk = (directory: string): void => {
    if (found.length >= 400) return
    let entries: ReturnType<typeof readdirSync>
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      try {
        if (entry.isDirectory()) {
          walk(path)
        } else if (
          entry.isFile() &&
          statSync(path).mtimeMs >= since &&
          statSync(path).size <= 4_000_000
        ) {
          found.push(path)
        }
      } catch {
        /* a file this test just created is the only thing here to disappear */
      }
    }
  }
  walk(root)
  return found
}
