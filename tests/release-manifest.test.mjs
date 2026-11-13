import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  officialVersionForPlatform,
  validateReleaseManifest,
} from '../installer/release-manifest.mjs'

const feed = (version) => ({
  version,
  url: 'https://example.test/feed.yml',
  path: 'https://example.test/desktop',
  sha512: Buffer.alloc(64, 1).toString('base64'),
})

const manifest = {
  schemaVersion: 1,
  channel: 'stable',
  releaseVersion: '0.2.63',
  tagName: 'opl-dsh-v0.2.63',
  official: {
    product: 'DeepSeek Harness',
    version: '0.2.2-rc.2',
    primaryPlatform: 'mac-arm64',
    feeds: {
      'mac-arm64': feed('0.2.2-rc.2'),
      'win-x64': feed('0.2.2-rc.1'),
    },
  },
  enhancement: {
    version: '0.2.63',
    asset: 'OPL-DSH-Enhancements.zip',
    sha256: 'sha256:' + 'a'.repeat(64),
    size: 1,
  },
}

test('release manifest accepts macOS-primary divergent feeds and selects by platform', () => {
  assert.equal(officialVersionForPlatform(manifest, 'darwin', 'arm64'), '0.2.2-rc.2')
  assert.equal(officialVersionForPlatform(manifest, 'win32', 'x64'), '0.2.2-rc.1')
  assert.doesNotThrow(() => validateReleaseManifest(manifest))
})

test('release manifest keeps macOS as the primary official version', () => {
  assert.throws(
    () =>
      validateReleaseManifest({
        ...manifest,
        official: { ...manifest.official, version: '0.2.2-rc.1' },
      }),
    /主版本必须来自 macOS feed/,
  )
})
