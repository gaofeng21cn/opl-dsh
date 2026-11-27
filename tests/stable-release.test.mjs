import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import YAML from 'yaml'
import {
  assertFrozenOfficialArchive,
  assertQualification,
} from '../scripts/publish-stable-release.mjs'
import { findReleaseCheckpoints } from '../scripts/release-recovery.mjs'
import { updateCaskMetadata } from '../scripts/sync-release-cask.mjs'

const artifact = {
  sourceCommit: 'a'.repeat(40),
  sourceTreeSha256: 'b'.repeat(64),
  enhancementVersion: '0.2.19',
  suiteSha256: 'c'.repeat(64),
  sha256: 'd'.repeat(64),
}
const feed = {
  url: 'https://download.deepseek.com/feed.yml',
  version: '0.2.0-rc.2',
  path: 'https://download.deepseek.com/desktop.exe',
  sha512: 'a'.repeat(86) + '==',
}
const manifest = {
  official: {
    version: feed.version,
    feeds: { 'mac-arm64': feed, 'win-x64': { ...feed } },
  },
}
function evidence(platform = 'darwin') {
  return {
    schemaVersion: 1,
    status: 'passed',
    sourceDirty: false,
    platform,
    arch: platform === 'darwin' ? 'arm64' : 'x64',
    ...artifact,
    enhancementSha256: artifact.sha256,
    officialVersion: manifest.official.version,
    officialIdentity: {
      signatureVerified: true,
      bundleId: 'com.deepseek.dsh',
      teamId: 'NAN929V4UM',
      publisher: 'Hangzhou DeepSeek Artificial Intelligence Co., Ltd.',
    },
    checks: {
      isolatedInstallation: true,
      officialUnmodified: true,
      downloadIntegrity: { sha512: true },
      client: { settings: true },
      runtime: {
        tools: true,
        officialCapabilities: {
          officialVersion: manifest.official.version,
          agentTeams: { owner: 'official', nativeChild: true, modelFacingTools: true },
          autoReview: {
            owner: 'official',
            mounted: true,
            defaultEnabled: false,
            selectablePreset: 'auto',
            defaultSelectable: false,
          },
          agentPresets: { owner: 'official' },
          oneShotProviders: [
            '@deepseek-ai/dsh-subagent-codex',
            '@deepseek-ai/dsh-subagent-claude-code',
          ].map((name) => ({
            package: name,
            owner: 'official',
            version: manifest.official.version,
          })),
        },
      },
      restart: { selections: true },
    },
  }
}

test('release requires both real platform identities and matching shipped bytes', () => {
  assertQualification(evidence(), artifact, manifest, 'darwin', 'arm64')
  assertQualification(evidence('win32'), artifact, manifest, 'win32', 'x64')
})

test('release requires official capability ownership and a completed native Team child', () => {
  for (const patch of [
    { officialVersion: '0.2.1-rc.5' },
    { agentTeams: { owner: 'official', modelFacingTools: true, nativeChild: false } },
    { autoReview: { owner: 'opl', mounted: true } },
    {
      autoReview: {
        owner: 'official',
        mounted: true,
        defaultEnabled: false,
        selectablePreset: 'auto',
        defaultSelectable: true,
      },
    },
    {
      autoReview: {
        ...evidence().checks.runtime.officialCapabilities.autoReview,
        defaultEnabled: true,
      },
    },
    { oneShotProviders: [] },
  ]) {
    const candidate = evidence()
    Object.assign(candidate.checks.runtime.officialCapabilities, patch)
    assert.throws(
      () => assertQualification(candidate, artifact, manifest, 'darwin', 'arm64'),
      /official capability/,
    )
  }
})

test('release rejects stale qualifications, dirty source and failed or wrong-platform runs', () => {
  for (const patch of [
    { sourceCommit: 'e'.repeat(40) },
    { sourceTreeSha256: 'e'.repeat(64) },
    { enhancementVersion: '0.2.18' },
    { suiteSha256: 'e'.repeat(64) },
    { enhancementSha256: 'e'.repeat(64) },
    { officialVersion: '0.2.0' },
    { sourceDirty: true },
    { sourceDirty: undefined },
    { status: 'failed' },
    { platform: 'win32' },
    { arch: 'x64' },
  ])
    assert.throws(() =>
      assertQualification({ ...evidence(), ...patch }, artifact, manifest, 'darwin', 'arm64'),
    )
})

test('release rejects missing signature, wrong official identity and skipped checks', () => {
  for (const patch of [
    { officialIdentity: { signatureVerified: false } },
    { officialIdentity: { ...evidence().officialIdentity, teamId: 'someone-else' } },
    { checks: { ...evidence().checks, client: {} } },
    { checks: { ...evidence().checks, runtime: null } },
    { checks: { ...evidence().checks, restart: [] } },
    { checks: { ...evidence().checks, officialUnmodified: false } },
    { checks: { ...evidence().checks, downloadIntegrity: {} } },
  ])
    assert.throws(() =>
      assertQualification({ ...evidence(), ...patch }, artifact, manifest, 'darwin', 'arm64'),
    )
  const windows = evidence('win32')
  windows.officialIdentity.publisher = 'someone-else'
  assert.throws(() => assertQualification(windows, artifact, manifest, 'win32', 'x64'))
})

test('stable workflow makes Windows qualification and evidence mandatory', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/stable-release.yml', import.meta.url),
    'utf8',
  )
  assert.doesNotMatch(workflow, /continue-on-error/)
  const jobs = YAML.parse(workflow).jobs
  assert.deepEqual(jobs.publish.needs, ['prepare', 'package', 'qualify'])
  const upload = jobs.qualify.steps.find((step) =>
    step.with?.name?.includes('release-qualification-diagnostics'),
  )
  assert.equal(
    jobs.qualify.steps.find((step) => step.id === 'qualification')?.['continue-on-error'],
    undefined,
  )
  assert.equal(
    upload.if,
    "${{ always() && (steps.qualification.outcome == 'success' || steps.qualification.outcome == 'failure') }}",
  )
  assert.equal(
    upload.with['if-no-files-found'],
    "${{ steps.qualification.outcome == 'success' && 'error' || 'warn' }}",
  )
  assert.match(
    jobs.qualify.steps.find((step) => step.name === 'Verify Windows launcher and ACL regressions')
      .run,
    /windows-acl\.test\.mjs/,
  )
  assert.equal(
    jobs.publish.steps.filter((step) => step.with?.path === 'dist/evidence/windows-latest').length,
    2,
  )
  assert.match(jobs.publish.if, /needs\.qualify\.result == 'success'/)
  assert.match(
    jobs.publish.if,
    /needs\.qualify\.result == 'skipped'.*needs\.prepare\.outputs\.mac_artifact != '' .*needs\.prepare\.outputs\.windows_artifact != ''/,
  )
  assert.equal(jobs['sync-cask'].needs, 'publish')
  assert.match(jobs['sync-cask'].if, /inputs\.cask_only/)

  const publisher = await readFile(
    new URL('../scripts/publish-stable-release.mjs', import.meta.url),
    'utf8',
  )
  assert.match(
    publisher,
    /const windowsEvidence = await readQualification\(root, 'windows-latest'\)/,
  )
  assert.doesNotMatch(publisher, /status: 'unavailable'|status: 'failed'/)
  assert.match(publisher, /OPL_PREPARED_OFFICIAL_WINDOWS_VERSION/)
})

test('compatibility retains qualification failures without secondary missing-artifact errors', async () => {
  const source = await readFile(
    new URL('../.github/workflows/official-compatibility.yml', import.meta.url),
    'utf8',
  )
  const steps = YAML.parse(source).jobs['official-desktop'].steps
  assert.equal(steps.find((step) => step.id === 'qualification')?.['continue-on-error'], undefined)
  const upload = steps.find((step) => step.with?.name === 'official-qualification-${{ matrix.os }}')
  assert.equal(
    upload.if,
    "${{ always() && (steps.qualification.outcome == 'success' || steps.qualification.outcome == 'failure') }}",
  )
  assert.equal(
    upload.with['if-no-files-found'],
    "${{ steps.qualification.outcome == 'success' && 'error' || 'warn' }}",
  )
})

test('recovery carries forward only successful evidence for the chosen candidate and verifier', async () => {
  const run = {
    path: '.github/workflows/stable-release.yml',
    status: 'completed',
    head_branch: 'main',
    event: 'workflow_dispatch',
    repository: { id: 100 },
    head_repository: { id: 100 },
  }
  const runs = [
    { ...run, id: 1 },
    { ...run, id: 2 },
    { ...run, id: 3, head_repository: { id: 200 } },
  ]
  const actionArtifact = (id, name, expired = false) => ({
    id,
    name,
    expired,
    digest: 'sha256:' + 'a'.repeat(64),
  })
  const api = async (path) => {
    if (path.includes('/workflows/')) return { workflow_runs: runs }
    if (path.includes('/runs/1/'))
      return {
        artifacts: [
          actionArtifact(10, 'release-candidate-frozen-1'),
          actionArtifact(11, 'release-qualification-macos-15-10-verifier'),
          actionArtifact(12, 'release-qualification-diagnostics-windows-latest-1'),
        ],
      }
    if (path.includes('/runs/2/'))
      return {
        artifacts: [
          actionArtifact(20, 'release-candidate-frozen-2', true),
          actionArtifact(21, 'release-qualification-windows-latest-20-verifier'),
          actionArtifact(22, 'release-qualification-windows-latest-10-old-verifier'),
        ],
      }
    assert.fail('must not query artifacts from a fork')
  }
  const discover = (packageKey, qualificationKey) =>
    findReleaseCheckpoints({ packageKey, qualificationKey }, { api, repositoryId: 100 })
  const matched = await discover('frozen', 'verifier')
  assert.equal(matched.candidate.id, 10)
  assert.equal(matched.evidence['macos-15'].id, 11)
  assert.deepEqual(matched.pending, ['windows-latest'])
  const changedVerifier = await discover('frozen', 'changed')
  assert.equal(changedVerifier.candidate.id, 10)
  assert.deepEqual(changedVerifier.pending, ['macos-15', 'windows-latest'])
  assert.equal((await discover('different-package', 'verifier')).candidate, undefined)
})

test('release binds each desktop qualification to the actual frozen upstream installer', () => {
  const candidate = evidence('win32')
  candidate.qualificationRunner = { sourceCommit: 'a'.repeat(40), sourceDirty: false }
  candidate.checks.downloadIntegrity.archiveSha512 = feed.sha512
  assertFrozenOfficialArchive(candidate, manifest)
  candidate.checks.downloadIntegrity.archiveSha512 = 'b'.repeat(86) + '=='
  assert.throws(() => assertFrozenOfficialArchive(candidate, manifest), /frozen official installer/)
})

test('Cask sync is idempotent and cannot downgrade a newer Cask on main', () => {
  const old = 'cask "opl-dsh" do\n  version "0.2.79"\n  sha256 "' + 'a'.repeat(64) + '"\nend\n'
  const identity = { version: '0.2.81', sha256: 'b'.repeat(64) }
  const expected = old.replace('0.2.79', identity.version).replace('a'.repeat(64), identity.sha256)
  assert.equal(updateCaskMetadata(old, identity), expected)
  assert.equal(updateCaskMetadata(expected, identity), expected)
  assert.throws(() => updateCaskMetadata(expected, { ...identity, version: '0.2.80' }), /newer/)
})
