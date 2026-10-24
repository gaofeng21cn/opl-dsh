import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  KIMI_CU_TEAM_ID,
  compareStableVersions,
  installKimiCu,
  kimiCuRelease,
  verifyKimiCuBundle,
} from '../installer/kimi-cu.mjs'

const manifest = {
  version: '0.6.8',
  app: {
    url: 'https://cdn.kimi.com/kimi-computer-use/0.6.8/KimiCU.app.zip',
    sha256: 'a'.repeat(64),
    team_id: KIMI_CU_TEAM_ID,
  },
  app_x86_64: {
    url: 'https://cdn.kimi.com/kimi-computer-use/0.6.8/KimiCU-x86_64.app.zip',
    sha256: 'b'.repeat(64),
    team_id: KIMI_CU_TEAM_ID,
  },
}

test('resolves the official stable archive for both Mac architectures', () => {
  assert.deepEqual(kimiCuRelease(manifest, 'darwin', 'arm64'), {
    version: '0.6.8',
    url: manifest.app.url,
    sha256: manifest.app.sha256,
    arch: 'arm64',
  })
  assert.equal(kimiCuRelease(manifest, 'darwin', 'x64').url, manifest.app_x86_64.url)
  assert.equal(kimiCuRelease(manifest, 'win32', 'x64'), undefined)
})

test('rejects redirects, prereleases, and a different signing team', () => {
  assert.throws(
    () =>
      kimiCuRelease(
        { ...manifest, app: { ...manifest.app, url: 'https://example.com/KimiCU.app.zip' } },
        'darwin',
        'arm64',
      ),
    /官方 CDN/,
  )
  assert.throws(
    () => kimiCuRelease({ ...manifest, version: '0.7.0-beta.1' }, 'darwin', 'arm64'),
    /稳定版本/,
  )
  assert.throws(
    () =>
      kimiCuRelease(
        { ...manifest, app: { ...manifest.app, team_id: 'DIFFERENTTEAM' } },
        'darwin',
        'arm64',
      ),
    /签名身份/,
  )
})

test('compares stable versions and never treats a prerelease as installable', () => {
  assert.ok(compareStableVersions('0.6.8', '0.6.6') > 0)
  assert.equal(compareStableVersions('0.6.8', '0.6.8'), 0)
  assert.throws(() => compareStableVersions('0.7.0-beta', '0.6.8'))
})

test('records a skipped companion without blocking non-macOS DSH installation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opl-kimi-cu-install-'))
  try {
    let fetched = false
    const result = await installKimiCu({
      suiteRoot: root,
      platform: 'win32',
      arch: 'x64',
      hostPlatform: 'win32',
      fetchImpl: async () => {
        fetched = true
        throw new Error('Windows must not fetch KimiCU')
      },
      inspect: () => {
        throw new Error('Windows must not inspect macOS applications')
      },
    })
    assert.equal(result.state, 'skipped')
    assert.equal(fetched, false)
    const receipt = JSON.parse(await readFile(join(root, 'kimi-cu-installation.json'), 'utf8'))
    assert.equal(receipt.state, 'skipped')
    assert.equal(receipt.platform, 'win32')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a non-macOS installer host skips before any filesystem or network action', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opl-kimi-cu-install-'))
  try {
    let fetched = false
    let inspected = false
    const result = await installKimiCu({
      suiteRoot: root,
      platform: 'darwin',
      arch: 'arm64',
      hostPlatform: 'win32',
      fetchImpl: async () => {
        fetched = true
        throw Error('must not fetch')
      },
      inspect: () => {
        inspected = true
        throw Error('must not inspect')
      },
    })
    assert.equal(result.state, 'skipped')
    assert.equal(fetched, false)
    assert.equal(inspected, false)
    const receipt = JSON.parse(await readFile(join(root, 'kimi-cu-installation.json'), 'utf8'))
    assert.equal(receipt.hostPlatform, 'win32')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('defers a failed download without inventing an installed state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opl-kimi-cu-install-'))
  try {
    const result = await installKimiCu({
      suiteRoot: root,
      appPath: join(root, 'KimiCU.app'),
      platform: 'darwin',
      arch: 'arm64',
      hostPlatform: 'darwin',
      fetchImpl: async () => {
        throw new Error('offline')
      },
    })
    assert.equal(result.state, 'deferred')
    const receipt = JSON.parse(await readFile(join(root, 'kimi-cu-installation.json'), 'utf8'))
    assert.equal(receipt.state, 'deferred')
    assert.match(receipt.message, /offline/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('offline mode preserves a verified installation without network access', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opl-kimi-cu-install-'))
  const previous = process.env.OPL_KIMI_CU_OFFLINE
  process.env.OPL_KIMI_CU_OFFLINE = '1'
  try {
    const appPath = join(root, 'KimiCU.app')
    let fetched = false
    const result = await installKimiCu({
      suiteRoot: root,
      appPath,
      platform: 'darwin',
      arch: 'arm64',
      hostPlatform: 'darwin',
      inspect: () => ({
        installed: true,
        verified: true,
        version: '0.6.8',
        executable: join(appPath, 'Contents/MacOS/kimi-cu'),
      }),
      configure: () => ({ initialized: true, tools: [], permissionsReady: true }),
      fetchImpl: async () => {
        fetched = true
        throw new Error('must not fetch')
      },
    })
    assert.equal(result.state, 'current')
    assert.equal(fetched, false)
    const receipt = JSON.parse(await readFile(join(root, 'kimi-cu-installation.json'), 'utf8'))
    assert.equal(receipt.state, 'current')
  } finally {
    if (previous === undefined) delete process.env.OPL_KIMI_CU_OFFLINE
    else process.env.OPL_KIMI_CU_OFFLINE = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('the installer payload names the companion installer as required', async () => {
  const update = await readFile(new URL('../installer/update.mjs', import.meta.url), 'utf8')
  const build = await readFile(new URL('../build.mjs', import.meta.url), 'utf8')
  assert.match(update, /'kimi-cu\.mjs'/)
  assert.match(build, /'kimi-cu\.mjs'/)
})

test('a local candidate archive is hash-bound and still requires the official manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opl-kimi-cu-install-'))
  const archive = join(root, 'KimiCU.app.zip')
  try {
    await writeFile(archive, 'fixture')
    const digest = (await import('node:crypto'))
      .createHash('sha256')
      .update('fixture')
      .digest('hex')
    const result = await installKimiCu({
      suiteRoot: root,
      appPath: join(root, 'KimiCU.app'),
      platform: 'darwin',
      arch: 'arm64',
      hostPlatform: 'darwin',
      archivePath: archive,
      expectedSha256: '0'.repeat(64),
      inspect: () => ({ installed: false, verified: false }),
    })
    assert.equal(result.state, 'deferred')
    assert.match(result.message, /本地归档 SHA-256/)
    const accepted = await installKimiCu({
      suiteRoot: root,
      appPath: join(root, 'KimiCU.app'),
      platform: 'darwin',
      arch: 'arm64',
      hostPlatform: 'darwin',
      archivePath: archive,
      expectedSha256: digest,
      inspect: () => ({ installed: false, verified: false }),
      fetchImpl: async () => {
        throw new Error('offline manifest check')
      },
    })
    assert.equal(accepted.state, 'deferred')
    assert.match(accepted.message, /offline manifest check/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a remote archive with the wrong SHA-256 is never unpacked or installed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opl-kimi-cu-install-'))
  try {
    const wrongHashManifest = {
      ...manifest,
      app: {
        ...manifest.app,
        sha256: createHash('sha256').update('expected bytes').digest('hex'),
      },
    }
    let verifies = false
    const result = await installKimiCu({
      suiteRoot: root,
      appPath: join(root, 'KimiCU.app'),
      platform: 'darwin',
      arch: 'arm64',
      hostPlatform: 'darwin',
      inspect: () => ({ installed: false, verified: false }),
      verifyBundle: () => {
        verifies = true
        throw new Error('must not verify an archive with the wrong hash')
      },
      fetchImpl: async (url) =>
        String(url).endsWith('version.json')
          ? new Response(JSON.stringify(wrongHashManifest), { status: 200 })
          : new Response('wrong bytes', { status: 200 }),
    })
    assert.equal(result.state, 'deferred')
    assert.match(result.message, /SHA-256/)
    assert.equal(verifies, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a local archive must provide an expected SHA-256', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opl-kimi-cu-install-'))
  const archive = join(root, 'KimiCU.app.zip')
  try {
    await writeFile(archive, 'fixture')
    const result = await installKimiCu({
      suiteRoot: root,
      appPath: join(root, 'KimiCU.app'),
      platform: 'darwin',
      arch: 'arm64',
      hostPlatform: 'darwin',
      archivePath: archive,
      inspect: () => ({ installed: false, verified: false }),
    })
    assert.equal(result.state, 'deferred')
    assert.match(result.message, /必须同时提供 SHA-256/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a failed post-install verification restores the previous verified app', async () => {
  if (process.platform !== 'darwin') return
  const root = await mkdtemp(join(tmpdir(), 'opl-kimi-cu-install-'))
  const appPath = join(root, 'KimiCU.app')
  try {
    await mkdir(appPath)
    await writeFile(join(appPath, 'sentinel'), 'previous verified app')
    let inspections = 0
    let verifies = 0
    const archive = Buffer.from('staged archive')
    const expected = {
      ...manifest,
      app: {
        ...manifest.app,
        sha256: createHash('sha256').update(archive).digest('hex'),
      },
    }
    const result = await installKimiCu({
      suiteRoot: root,
      appPath,
      platform: 'darwin',
      arch: 'arm64',
      hostPlatform: 'darwin',
      inspect: () => {
        inspections++
        return inspections === 1
          ? { installed: true, verified: true, version: '0.6.6', executable: join(appPath, 'old') }
          : { installed: true, verified: true, version: '0.6.8', executable: join(appPath, 'new') }
      },
      verifyBundle: (_path, _version, architecture) => {
        assert.equal(architecture, 'arm64')
        verifies++
        if (verifies > 1) throw new Error('post-install signature mismatch')
        return { bundleId: 'ai.kimi.cu', version: '0.6.8', arch: 'arm64' }
      },
      configure: () => {
        throw Error('must not configure an unverified replacement')
      },
      unpack: (_archive, destination) => {
        const staged = join(destination, 'KimiCU.app')
        mkdirSync(staged, { recursive: true })
        return { ok: true, stdout: '', stderr: '', status: 0 }
      },
      fetchImpl: async (url) =>
        String(url).endsWith('version.json')
          ? new Response(JSON.stringify(expected), { status: 200 })
          : new Response(archive, { status: 200 }),
    })
    assert.equal(result.state, 'deferred')
    assert.match(result.message, /post-install signature mismatch/)
    assert.equal(await readFile(join(appPath, 'sentinel'), 'utf8'), 'previous verified app')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('verification covers signature, notarization, identity, version, and architecture', async () => {
  if (process.platform !== 'darwin') return
  const root = await mkdtemp(join(tmpdir(), 'opl-kimi-cu-verify-'))
  const app = join(root, 'KimiCU.app')
  try {
    await mkdir(join(app, 'Contents/MacOS'), { recursive: true })
    await writeFile(
      join(app, 'Contents/Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>ai.kimi.cu</string>
<key>CFBundleShortVersionString</key><string>0.6.8</string>
</dict></plist>
`,
    )
    await writeFile(join(app, 'Contents/MacOS/kimi-cu'), '#!/bin/sh\n', { mode: 0o700 })
    assert.throws(() => verifyKimiCuBundle(app, '0.6.8', 'arm64'), /签名、Team ID 或公证校验失败/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
