import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  installWindowsKimiCu,
  validateWindowsKimiCuEntry,
  windowsKimiCuRelease,
  unpackWindowsKimiCu,
  verifyWindowsKimiCuSignature,
  WINDOWS_KIMI_CU_MANIFEST_URL,
  WINDOWS_KIMI_CU_SIGNER,
} from '../installer/kimi-cu-windows.mjs'

const base = 'https://cdn.kimi.com/kimi-computer-use-windows/0.3.10/'
const manifest = {
  version: '0.3.10',
  plugin: {
    url: `${base}kimi-cu-win-plugin.zip`,
    sha256: 'aae21d2b5b8eb601f8f89b29e3ccc3ffab32db95f009a1e7e0a5409eefe4cea9',
  },
  runtime: {
    url: `${base}kimi-cu-win-runtime.zip`,
    sha256: '46e2900b93353af6f44391451126575967192340daa3b952b34e92f6a88a9bd4',
    executable_url: `${base}kimi-cu.exe`,
    executable_sha256: 'ab33418e9bf042775116a9334cb3ea5be923cc8ebcead1c060d86f9742f96936',
    signer_sha1: WINDOWS_KIMI_CU_SIGNER,
  },
}

async function isolated(run) {
  const root = await mkdtemp(join(tmpdir(), 'opl-kimi-windows-test-'))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('Windows release pins version, HTTPS addresses, digests and publisher', () => {
  assert.equal(windowsKimiCuRelease(manifest), manifest)
  for (const mutation of [
    { version: '0.3.11' },
    { plugin: { ...manifest.plugin, url: `${base}../latest/kimi-cu-win-plugin.zip` } },
    { plugin: { ...manifest.plugin, sha256: 'a'.repeat(64) } },
    { runtime: { ...manifest.runtime, signer_sha1: '0'.repeat(40) } },
    { runtime: { ...manifest.runtime, executable_url: 'http://cdn.kimi.com/kimi-cu.exe' } },
  ])
    assert.throws(() => windowsKimiCuRelease({ ...manifest, ...mutation }))
})

test('Windows ZIP paths reject traversal, drive paths, alternate streams and aliases', () => {
  assert.equal(
    validateWindowsKimiCuEntry('public/node_modules/@kimi/cu/index.mjs'),
    'public/node_modules/@kimi/cu/index.mjs',
  )
  for (const path of [
    '../escape',
    '/absolute',
    'C:/escape',
    'a/../../escape',
    'a\\..\\escape',
    'a:stream',
    'CON.txt',
    'a/NUL',
    'a./b',
    'a /b',
    'a//b',
    'a/./b',
  ])
    assert.throws(() => validateWindowsKimiCuEntry(path), /不安全路径/)
})

test('unsupported Windows architecture skips without network or signature execution', async () => {
  await isolated(async (root) => {
    const result = await installWindowsKimiCu({
      suiteRoot: root,
      platform: 'win32',
      arch: 'arm64',
      fetchImpl: () => assert.fail('network'),
      verifySignature: () => assert.fail('signature'),
    })
    assert.equal(result.state, 'skipped')
  })
})

test('wrong archive digest never reaches extraction and leaves no installation', async () => {
  await isolated(async (root) => {
    const calls = []
    const result = await installWindowsKimiCu({
      suiteRoot: join(root, 'suite'),
      installRoot: join(root, 'managed', '0.3.10'),
      platform: 'win32',
      arch: 'x64',
      unpack: () => assert.fail('unpack'),
      verifySignature: () => assert.fail('signature'),
      fetchImpl: async (url, options) => {
        calls.push(url)
        assert.equal(options.redirect, 'error')
        return new Response(
          url === WINDOWS_KIMI_CU_MANIFEST_URL ? JSON.stringify(manifest) : 'wrong archive',
        )
      },
    })
    assert.equal(result.state, 'deferred')
    assert.match(result.message, /SHA-256/)
    assert.deepEqual(calls, [WINDOWS_KIMI_CU_MANIFEST_URL, manifest.plugin.url])
    assert.deepEqual(await readdir(join(root, 'managed')), [])
    const receipt = JSON.parse(
      await readFile(join(root, 'suite', 'kimi-cu-installation.json'), 'utf8'),
    )
    assert.equal(receipt.staticVerified, false)
    assert.equal(receipt.runtimeVerified, false)
  })
})

test('oversized manifest is rejected before its body is consumed', async () => {
  await isolated(async (root) => {
    const result = await installWindowsKimiCu({
      installRoot: join(root, 'managed'),
      platform: 'win32',
      arch: 'x64',
      fetchImpl: async () => new Response('{}', { headers: { 'content-length': '65537' } }),
    })
    assert.equal(result.state, 'deferred')
    assert.match(result.message, /大小上限/)
    assert.deepEqual(await readdir(root), [])
  })
})

test('streamed manifest size is bounded when content-length is absent', async () => {
  await isolated(async (root) => {
    let cancelled = false
    const result = await installWindowsKimiCu({
      installRoot: join(root, 'managed'),
      platform: 'win32',
      arch: 'x64',
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array(32769))
            },
            cancel() {
              cancelled = true
            },
          }),
        ),
    })
    assert.equal(result.state, 'deferred')
    assert.match(result.message, /大小上限/)
    assert.equal(cancelled, true)
  })
})

test(
  'unsigned Windows executable fails Authenticode without execution',
  { skip: process.platform !== 'win32' },
  async () => {
    await isolated(async (root) => {
      const executable = join(root, 'unsigned.exe')
      await writeFile(executable, 'not an executable')
      assert.throws(() => verifyWindowsKimiCuSignature(executable), /签名或发布者不匹配/)
    })
  },
)

test('unverified existing files are preserved without downloading a replacement', async () => {
  await isolated(async (root) => {
    const target = join(root, 'existing')
    await mkdir(target)
    await writeFile(join(target, 'sentinel'), 'user data')
    const result = await installWindowsKimiCu({
      installRoot: target,
      platform: 'win32',
      arch: 'x64',
      fetchImpl: () => assert.fail('network'),
    })
    assert.equal(result.state, 'deferred')
    assert.equal(await readFile(join(target, 'sentinel'), 'utf8'), 'user data')
  })
})

test('relative Node executable fails before network or filesystem installation', async () => {
  const result = await installWindowsKimiCu({
    platform: 'win32',
    arch: 'x64',
    nodeExecutable: 'node.exe',
    fetchImpl: () => assert.fail('network'),
  })
  assert.equal(result.state, 'deferred')
  assert.match(result.message, /绝对路径/)
})

test(
  'real Windows extractor rejects traversal before writing an archive entry',
  { skip: process.platform !== 'win32' },
  async () => {
    await isolated(async (root) => {
      const archive = join(root, 'unsafe.zip')
      const created = spawnSync(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::Open($env:OPL_TEST_ZIP,'Create'); try {$null=$z.CreateEntry('../escape.txt')} finally {$z.Dispose()}",
        ],
        {
          env: { ...process.env, OPL_TEST_ZIP: archive },
          encoding: 'utf8',
          windowsHide: true,
          timeout: 15000,
        },
      )
      assert.equal(created.status, 0, created.stderr)
      assert.throws(() => unpackWindowsKimiCu(archive, join(root, 'payload')), /ZIP unsafe path/)
      assert.deepEqual(await readdir(root), ['unsafe.zip'])
    })
  },
)

test('default Windows component directory belongs to the supplied Suite root', async () => {
  await isolated(async (root) => {
    const target = join(root, 'kimi-cu', '0.3.10')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'sentinel'), 'preserve')
    const result = await installWindowsKimiCu({
      suiteRoot: root,
      platform: 'win32',
      arch: 'x64',
      fetchImpl: () => assert.fail('must inspect the existing Suite directory before downloading'),
    })
    assert.equal(result.state, 'deferred')
    assert.equal(await readFile(join(target, 'sentinel'), 'utf8'), 'preserve')
    assert.equal(
      JSON.parse(await readFile(join(root, 'kimi-cu-installation.json'), 'utf8')).state,
      'deferred',
    )
  })
})
