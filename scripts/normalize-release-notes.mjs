import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stripDuplicateReleaseHeading } from './release-notes.mjs'

const repository = 'gaofeng21cn/opl-dsh'
if (process.env.GITHUB_REPOSITORY !== repository)
  throw Error('This maintenance script only writes to gaofeng21cn/opl-dsh')
const command = (args) => execFileSync('gh', args, { encoding: 'utf8' })
const readRelease = () => JSON.parse(command(['api', `repos/${repository}/releases/latest`]))
const assetIdentity = (release) =>
  release.assets
    .map(({ id, name, size, digest, browser_download_url }) => ({
      id,
      name,
      size,
      digest,
      browser_download_url,
    }))
    .sort((a, b) => a.id - b.id)
const before = readRelease()
if (before.draft || before.prerelease || !/^opl-dsh-v\d+\.\d+\.\d+$/.test(before.tag_name))
  throw Error('Expected a canonical published stable release')
const notes = stripDuplicateReleaseHeading(before.body, before.name)
if (!notes.trim()) throw Error('Refusing to leave an empty release body')
const audit = join(import.meta.dirname, '../dist/release-notes-audit')
await mkdir(audit, { recursive: true })
await writeFile(join(audit, 'before.json'), JSON.stringify(before, null, 2) + '\n')
if (notes !== before.body) {
  const notesFile = join(audit, 'notes.md')
  await writeFile(notesFile, notes)
  command(['release', 'edit', before.tag_name, '--repo', repository, '--notes-file', notesFile])
}
const after = readRelease()
for (const field of ['id', 'tag_name', 'name', 'draft', 'prerelease', 'target_commitish'])
  if (after[field] !== before[field]) throw Error(`Release ${field} changed during maintenance`)
if (
  after.body !== notes ||
  JSON.stringify(assetIdentity(after)) !== JSON.stringify(assetIdentity(before))
)
  throw Error('Release body did not match the correction or release assets changed')
await writeFile(join(audit, 'after.json'), JSON.stringify(after, null, 2) + '\n')
console.log(
  JSON.stringify({ url: after.html_url, updated: notes !== before.body, assetsUnchanged: true }),
)
