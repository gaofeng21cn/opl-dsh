import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
// `new URL(...).pathname` yields `/C:/...` on Windows, which no POSIX tool can open.
const parser = fileURLToPath(new URL('../installer/official-feed.awk', import.meta.url))
const parse = (input) =>
  execFileSync('awk', ['-f', parser], { input, encoding: 'utf8' }).trim().split('\n')
// official-feed.awk is a POSIX awk program used by the shell installer: without an awk binary
// there is nothing to test, so only that environment is skipped rather than the assertions.
const awkMissing =
  spawnSync('awk', ['-f', parser], { input: '' }).error?.code === 'ENOENT'
    ? '本机没有可用的 POSIX awk，无法运行 installer/official-feed.awk'
    : false
test(
  'official desktop feed supports a future version and folded scalars, independently of GitHub source releases',
  { skip: awkMissing },
  () => {
    const version = '0.2.0-rc.1',
      url = `https://download.deepseek.com/dsh-desk/bin/mac-arm64/deepseek-harness-${version}-mac-arm64.zip`,
      hash = 'a'.repeat(86) + '=='
    assert.deepEqual(
      parse(
        `version: ${version}\nfiles:\n  - url: ignore-nested\n    sha512: ignore-nested\npath: >-\n  ${url}\nsha512: >-\n  ${hash}\n`,
      ),
      [version, url, hash],
    )
    assert.deepEqual(parse(`version: ${version}\npath: ${url}\nsha512: ${hash}\n`), [
      version,
      url,
      hash,
    ])
    assert.throws(() => parse('version: 0.2.0\npath: something\n'))
    assert.throws(() => parse('version: 0.2.0\nversion: 0.3.0\npath: something\nsha512: hash\n'))
  },
)
