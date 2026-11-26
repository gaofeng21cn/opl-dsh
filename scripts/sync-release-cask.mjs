import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateReleaseManifest } from '../installer/release-manifest.mjs'

const repository = 'gaofeng21cn/opl-dsh'
const archiveName = 'OPL-DSH-Enhancements.zip'
const caskPath = 'Casks/opl-dsh.rb'
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const versionLine = /^  version "(\d+\.\d+\.\d+)"$/m
const sha256Line = /^  sha256 "([a-f0-9]{64})"$/m

export async function readPublicCaskRelease(release, directory, expectedTag) {
  const tag = release.tag_name
  if (
    release.draft !== false ||
    release.prerelease !== false ||
    !/^opl-dsh-v\d+\.\d+\.\d+$/.test(tag ?? '') ||
    (expectedTag && expectedTag !== tag)
  )
    throw Error('Cask sync requires the canonical public Latest release')
  const version = tag.slice('opl-dsh-v'.length)
  const files = [
    archiveName,
    'OPL-DSH-Installer-mac-arm64.dmg',
    'OPL-DSH-Installer-windows-x64.exe',
    'release-manifest.json',
    'official-qualification-' + version + '.json',
  ]
  const assets = new Map(release.assets.map((asset) => [asset.name, asset]))
  if (release.assets.length !== files.length + 1)
    throw Error('Public release asset count differs from the stable release contract')
  const read = async (name) => {
    const bytes = await readFile(join(directory, name))
    const asset = assets.get(name)
    if (!bytes.length || asset?.size !== bytes.length || asset.digest !== 'sha256:' + digest(bytes))
      throw Error('Public release asset digest differs: ' + name)
    return bytes
  }
  const checksumLines = (await read('SHA256SUMS')).toString('utf8').trim().split('\n')
  const bytes = await Promise.all(files.map(read))
  if (
    checksumLines.length !== files.length ||
    !files.every((name, index) => checksumLines.includes(digest(bytes[index]) + '  ' + name))
  )
    throw Error('Public SHA256SUMS differs from the downloaded release')
  const manifest = validateReleaseManifest(JSON.parse(bytes[3]), {
    tagName: tag,
    assetName: archiveName,
    requireMatchingOfficialFeeds: true,
  })
  const sha256 = digest(bytes[0])
  const qualification = JSON.parse(bytes[4])
  if (
    manifest.enhancement.sha256 !== 'sha256:' + sha256 ||
    manifest.enhancement.size !== bytes[0].length ||
    manifest.qualification !== files[4] ||
    !/^[a-f0-9]{40}$/.test(manifest.sourceCommit ?? '') ||
    qualification.status !== 'passed' ||
    qualification.sourceCommit !== manifest.sourceCommit ||
    qualification.enhancementVersion !== version ||
    qualification.officialVersion !== manifest.official.version ||
    !['darwin', 'win32'].every(
      (platform) => qualification.platforms?.[platform]?.status === 'passed',
    )
  )
    throw Error('Public release manifest, enhancement ZIP or qualification do not match')
  return { tag, version, sha256, sourceCommit: manifest.sourceCommit }
}

export function updateCaskMetadata(current, { version, sha256 }) {
  const previous = current.match(versionLine)?.[1]
  if (!previous || !sha256Line.test(current))
    throw Error('Cask version or SHA-256 stanza is missing')
  const [oldMajor, oldMinor, oldPatch] = previous.split('.').map(Number)
  const [newMajor, newMinor, newPatch] = version.split('.').map(Number)
  if ((newMajor - oldMajor || newMinor - oldMinor || newPatch - oldPatch) < 0)
    throw Error('Cask already points to a newer version')
  return current
    .replace(versionLine, '  version "' + version + '"')
    .replace(sha256Line, '  sha256 "' + sha256 + '"')
}

export async function syncReleaseCask(root) {
  if (process.env.GITHUB_REPOSITORY !== repository) throw Error('Unexpected release repository')
  const command = (program, args) =>
    execFileSync(program, args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  const git = (...args) => command('git', args)
  const latest = () =>
    JSON.parse(command('gh', ['api', 'repos/' + repository + '/releases/latest']))
  const release = latest()
  const expectedTag = process.env.OPL_RELEASE_TAG
  if (
    !/^opl-dsh-v\d+\.\d+\.\d+$/.test(release.tag_name ?? '') ||
    (expectedTag && release.tag_name !== expectedTag)
  )
    throw Error('Public Latest has moved or has an invalid tag')

  const directory = await mkdtemp(join(tmpdir(), 'opl-dsh-public-release-'))
  try {
    command('gh', [
      'release',
      'download',
      release.tag_name,
      '--repo',
      repository,
      '--dir',
      directory,
    ])
    const identity = await readPublicCaskRelease(release, directory, expectedTag)
    if (git('status', '--porcelain')) throw Error('Cask sync requires a clean checkout')
    for (let attempt = 0; attempt <= 3; attempt++) {
      git('fetch', 'origin', 'main', '--tags')
      if (git('rev-parse', identity.tag + '^{commit}') !== identity.sourceCommit)
        throw Error('Public release manifest does not match its canonical tag')
      git('merge-base', '--is-ancestor', identity.sourceCommit, 'origin/main')
      const readback = latest()
      if (
        readback.id !== release.id ||
        readback.tag_name !== identity.tag ||
        readback.draft !== false ||
        readback.prerelease !== false ||
        !readback.assets.some(
          (asset) => asset.name === archiveName && asset.digest === 'sha256:' + identity.sha256,
        )
      )
        throw Error('Public Latest changed during Cask sync')
      const current = git('show', 'origin/main:' + caskPath)
      const updated = updateCaskMetadata(current, identity)
      if (updated === current) {
        console.log(
          JSON.stringify({
            ...identity,
            homebrew: 'passed',
            mainCommit: git('rev-parse', 'origin/main'),
          }),
        )
        return
      }
      if (attempt === 3) throw Error('Cask update did not reach main after 3 push attempts')
      git('switch', '--detach', 'origin/main')
      await writeFile(join(root, caskPath), updated)
      command('ruby', ['-c', caskPath])
      git('add', '--', caskPath)
      git(
        '-c',
        'user.name=github-actions[bot]',
        '-c',
        'user.email=41898282+github-actions[bot]@users.noreply.github.com',
        'commit',
        '-m',
        'chore: update Homebrew Cask to OPL DSH v' + identity.version,
      )
      // A normal push rejects a moved main. Reconcile origin/main before any retry.
      const push = spawnSync('git', ['push', 'origin', 'HEAD:main'], {
        cwd: root,
        encoding: 'utf8',
      })
      if (push.status !== 0)
        console.warn('Cask push did not confirm success, checking origin/main.')
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await syncReleaseCask(process.cwd())
