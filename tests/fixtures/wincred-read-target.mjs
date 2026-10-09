/**
 * Read one keyring credential from a separate OS process.
 *
 * The point of this helper is the process boundary: it proves a key written by
 * the suite is readable by a *different* process through the Windows
 * Credential Manager, rather than only by whatever memory the writer still
 * held. Run it with `node`, not through the test runner, so the read genuinely
 * happens in a fresh process.
 *
 * It reports a length and a SHA-256 digest and never the value, so the output
 * this produces is safe to print in a test failure.
 *
 * Usage: node tests/fixtures/wincred-read-target.mjs <target>
 */

import { createHash } from 'node:crypto'
import {
  wincredExists,
  wincredRead,
} from '../../src/credentials/host/windows-credential-manager.ts'

const target = process.argv[2]

if (target === undefined || target === '') {
  process.stderr.write('usage: wincred-read-target.mjs <target>\n')
  process.exit(2)
}

const configured = await wincredExists(target)
const value = configured ? await wincredRead(target) : undefined

process.stdout.write(
  `${JSON.stringify({
    pid: process.pid,
    configured,
    length: value?.length ?? null,
    sha256: value === undefined ? null : createHash('sha256').update(value).digest('hex'),
  })}\n`,
)
