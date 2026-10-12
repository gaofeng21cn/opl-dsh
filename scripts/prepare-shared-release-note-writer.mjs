/** Optional public-source transport; provider policy and execution belong to Framework. */
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const repository = 'gaofeng21cn/one-person-lab'
export async function prepareSharedReleaseNoteWriter({
  request = fetch,
  ref = 'main',
  install = true,
} = {}) {
  let root
  try {
    const read = async (url) => {
      const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
      const headers =
        url.startsWith('https://api.github.com/') && token
          ? { authorization: 'Bearer ' + token }
          : {}
      const response = await request(url, { headers, signal: AbortSignal.timeout(20_000) })
      if (!response.ok) throw Error('shared_writer_source_unavailable')
      return response
    }
    // Resolve once, then download both files from this exact commit, outside the product tree.
    const commit = await (
      await read(`https://api.github.com/repos/${repository}/commits/${ref}`)
    ).json()
    if (!/^[0-9a-f]{40}$/.test(commit.sha)) throw Error('invalid_shared_writer_commit')
    root = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), 'opl-shared-note-writer-'))
    for (const file of ['policy.json', 'writer.mjs']) {
      const response = await read(
        `https://raw.githubusercontent.com/${repository}/${commit.sha}/scripts/release-note-writer/${file}`,
      )
      await writeFile(join(root, file), await response.text())
    }
    const module = join(root, 'writer.mjs')
    // Invalid or incomplete policy cannot expose a partially prepared writer.
    await import(pathToFileURL(module).href)
    if (install)
      try {
        await promisify(execFile)(process.execPath, [module, '--prepare'], {
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
          },
          timeout: 130_000,
          maxBuffer: 128 * 1024,
          killSignal: 'SIGKILL',
        })
      } catch {
        console.log('CLI bootstrap unavailable; shared Gateway writer remains available.')
      }
    if (process.env.GITHUB_ENV)
      await appendFile(
        process.env.GITHUB_ENV,
        `OPL_RELEASE_NOTES_WRITER_MODULE=${module}\nOPL_RELEASE_NOTES_WRITER_SHA=${commit.sha}\n`,
      )
    console.log(`Shared release-note writer: ${repository}@${commit.sha}`)
    return { module, source_commit: commit.sha }
  } catch {
    if (root) await rm(root, { recursive: true, force: true })
    console.log(
      'Shared release-note writer unavailable; product mechanical notes remain available.',
    )
    return null
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await prepareSharedReleaseNoteWriter()
