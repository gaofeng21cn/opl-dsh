import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'
import { execFileSync } from 'node:child_process'
import { planDailyRelease } from '../scripts/prepare-daily-release.mjs'
import { dailyReleaseNotes, writeDailyReleaseNotes } from '../scripts/daily-release-notes.mjs'
import { renderReleaseNotes } from '../scripts/release-notes.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'opl-daily-release-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  git('init', '-b', 'main')
  git('config', 'user.name', 'Release fixture')
  git('config', 'user.email', 'fixture@example.invalid')
  for (const dir of ['src', 'Casks', 'docs']) await mkdir(join(root, dir))
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.2.21' }))
  await writeFile(join(root, 'src/plugin.ts'), 'export const value = 1\n')
  await writeFile(join(root, 'Casks/opl-dsh.rb'), 'old metadata\n')
  git('add', '.')
  git('commit', '-m', 'Initial release')
  git('tag', 'opl-dsh-v0.2.21')
  const latest = { tag_name: 'opl-dsh-v0.2.21', draft: false, prerelease: false }
  const commit = () => {
    git('add', '.')
    git('commit', '-m', 'Fixture change')
  }
  return { root, git, latest, commit }
}

test('daily detection skips Cask follow-up and docs-only changes instead of releasing forever', async (t) => {
  const { root, latest, commit } = await fixture(t)
  await writeFile(join(root, 'Casks/opl-dsh.rb'), 'public release checksum\n')
  await writeFile(join(root, 'docs/release-policy.md'), 'Daily publication policy\n')
  commit()
  assert.equal((await planDailyRelease(root, latest)).action, 'skip')
})

test('an unversioned product fix gets the next stable patch', async (t) => {
  const { root, latest, commit } = await fixture(t)
  await writeFile(join(root, 'src/plugin.ts'), 'export const value = 2\n')
  commit()
  assert.deepEqual(await planDailyRelease(root, latest), {
    action: 'prepare',
    version: '0.2.22',
    baseline: latest.tag_name,
  })
})

test('prepared versions are retained and a failed frozen candidate is resumed without a new tag', async (t) => {
  const { root, git, latest, commit } = await fixture(t)
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.3.0' }))
  commit()
  assert.equal((await planDailyRelease(root, latest)).version, '0.3.0')
  git('tag', 'opl-dsh-v0.3.0')
  const frozen = git('rev-parse', 'HEAD')
  await writeFile(join(root, 'docs/status.md'), 'A later documentation change\n')
  commit()
  assert.deepEqual(await planDailyRelease(root, latest), {
    action: 'resume',
    tag: 'opl-dsh-v0.3.0',
    sourceCommit: frozen,
  })
})

test('dirty or divergent source and nonstable Latest fail before allocating a version', async (t) => {
  const { root, git, latest, commit } = await fixture(t)
  await writeFile(join(root, 'src/plugin.ts'), 'dirty\n')
  await assert.rejects(planDailyRelease(root, latest), /clean source/)
  commit()
  await assert.rejects(planDailyRelease(root, { ...latest, prerelease: true }), /canonical stable/)
  git('checkout', '--orphan', 'unrelated')
  git('commit', '-m', 'Unrelated root')
  await assert.rejects(planDailyRelease(root, latest))
  assert.equal(JSON.parse(await readFile(join(root, 'package.json'))).version, '0.2.21')
})

test('automatic Chinese release notes retain original commit text and render all provenance fields', () => {
  const changes =
    '- fix: preserve draft ([查看提交](https://github.com/gaofeng21cn/opl-dsh/commit/abc))'
  const notes = renderReleaseNotes(dailyReleaseNotes({ changes }), {
    version: '0.2.22',
    officialVersion: '0.2.0-rc.2',
    sourceCommit: 'a'.repeat(40),
  })
  assert.ok(notes.startsWith('官方 DeepSeek Harness：'))
  assert.ok(notes.includes(changes))
  assert.ok(notes.includes('a'.repeat(40)))
  assert.ok(!notes.includes('{{'))
})

const notesEvidence = {
  commitsMarkdown:
    '- fix: preserve draft ([查看提交](https://github.com/gaofeng21cn/opl-dsh/commit/abc))',
  diff: '- overwrite draft\n+ preserve draft',
}

test('online writer uses the requested deepseek-flash and separates user copy from qualification facts', async () => {
  let calls = 0
  const result = await writeDailyReleaseNotes(notesEvidence, {
    apiKey: 'secret-fixture-key',
    request: async (url, options) => {
      calls++
      assert.equal(url, 'https://gateway.medopl.com/v1/chat/completions')
      const body = JSON.parse(options.body)
      assert.equal(body.model, 'deepseek-flash')
      assert.equal(JSON.parse(body.messages[1].content).diff, notesEvidence.diff)
      return Response.json({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                overview: '编辑时保留已有草稿。',
                changes: ['已有草稿不再被回填覆盖。'],
                limitations: [],
              }),
            },
          },
        ],
      })
    },
  })
  assert.equal(calls, 1)
  assert.equal(result.mode, 'online-ai')
  assert.ok(result.notes.includes('已有草稿不再被回填覆盖'))
  assert.ok(result.notes.includes('OPL_DSH_RELEASE_NOTES:online-ai:deepseek-flash'))
  assert.ok(!result.notes.includes('secret-fixture-key'))
})

test('credential absence, provider failures and malformed or incomplete replies always produce publishable mechanical notes', async () => {
  const requests = [
    async () => {
      throw Error('timeout with secret-fixture-key')
    },
    async () => new Response('', { status: 429 }),
    async () =>
      Response.json({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }),
    async () => Response.json({ choices: [{ message: { content: 'not JSON' } }] }),
    async () =>
      Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                overview: 'secret-fixture-key',
                changes: ['x'],
                limitations: [],
              }),
            },
          },
        ],
      }),
  ]
  const results = [await writeDailyReleaseNotes(notesEvidence)]
  for (const request of requests)
    results.push(
      await writeDailyReleaseNotes(notesEvidence, { apiKey: 'secret-fixture-key', request }),
    )
  for (const result of results) {
    assert.equal(result.mode, 'mechanical')
    assert.ok(result.notes.includes(notesEvidence.commitsMarkdown))
    assert.ok(result.notes.includes('OPL_DSH_RELEASE_NOTES:mechanical'))
    assert.ok(!JSON.stringify(result).includes('secret-fixture-key'))
    assert.doesNotThrow(() =>
      renderReleaseNotes(result.notes, {
        version: '0.2.22',
        officialVersion: '0.2.0-rc.2',
        sourceCommit: 'a'.repeat(40),
      }),
    )
  }
})

test('Copilot auto succeeds before Gateway, and quota or invalid replies fall through in the required order', async () => {
  const copy = JSON.stringify({
    overview: '保留草稿。',
    changes: ['已有草稿不会被覆盖。'],
    limitations: [],
  })
  let gatewayCalls = 0
  const request = async () => {
    gatewayCalls++
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: copy } }] })
  }
  const options = { apiKey: 'gateway-secret', copilotToken: 'copilot-secret', request }
  const first = await writeDailyReleaseNotes(notesEvidence, {
    ...options,
    copilot: async () => copy,
  })
  assert.equal(first.model, 'copilot-auto')
  assert.equal(gatewayCalls, 0)
  assert.deepEqual(first.attempts, [{ provider: 'copilot-auto', status: 'passed' }])
  for (const copilot of [
    async () => {
      throw Error('quota exhausted with copilot-secret')
    },
    async () => 'invalid JSON',
  ]) {
    const second = await writeDailyReleaseNotes(notesEvidence, { ...options, copilot })
    assert.equal(second.model, 'deepseek-flash')
    assert.deepEqual(
      second.attempts.map(({ provider, status }) => [provider, status]),
      [
        ['copilot-auto', 'failed'],
        ['deepseek-flash', 'passed'],
      ],
    )
    assert.ok(!JSON.stringify(second).includes('copilot-secret'))
  }
  const third = await writeDailyReleaseNotes(notesEvidence, {
    ...options,
    copilot: async () => 'invalid',
    request: async () => new Response('', { status: 429 }),
  })
  assert.equal(third.mode, 'mechanical')
  assert.deepEqual(
    third.attempts.map(({ provider, status }) => [provider, status]),
    [
      ['copilot-auto', 'failed'],
      ['deepseek-flash', 'failed'],
      ['gpt-6-luna', 'failed'],
    ],
  )
  assert.doesNotThrow(() =>
    renderReleaseNotes(third.notes, {
      version: '0.2.22',
      officialVersion: '0.2.0-rc.2',
      sourceCommit: 'a'.repeat(40),
    }),
  )
})

test(
  'real preparation pushes one frozen candidate and the next run resumes it',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { root, git, latest, commit } = await fixture(t)
    const external = await mkdtemp(join(tmpdir(), 'opl-daily-remote-'))
    t.after(() => rm(external, { recursive: true, force: true }))
    const remote = join(external, 'origin.git')
    execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' })
    git('remote', 'add', 'origin', remote)
    await mkdir(join(root, 'scripts'))
    for (const file of [
      'prepare-daily-release.mjs',
      'daily-release-notes.mjs',
      'copilot-release-notes.mjs',
    ])
      await copyFile(new URL('../scripts/' + file, import.meta.url), join(root, 'scripts', file))
    await writeFile(
      join(root, 'package-lock.json'),
      JSON.stringify({ version: '0.2.21', packages: { '': { version: '0.2.21' } } }),
    )
    await writeFile(join(root, 'src/plugin.ts'), 'export const value = 2\n')
    commit()
    git('push', 'origin', 'main', '--tags')
    const bin = join(external, 'bin')
    await mkdir(bin)
    // Only Latest metadata is simulated; version writes, commits, tags, pushes,
    // remote readback and workflow outputs use the actual production entry point.
    await writeFile(
      join(bin, 'gh'),
      `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(latest))})\n`,
      { mode: 0o700 },
    )
    const output = join(external, 'output')
    const env = {
      ...process.env,
      PATH: bin + delimiter + process.env.PATH,
      GITHUB_REPOSITORY: 'gaofeng21cn/opl-dsh',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: join(external, 'summary'),
    }
    delete env.OPL_RELEASE_NOTES_CODEX_API_KEY
    delete env.GITHUB_TOKEN
    const run = () =>
      JSON.parse(
        execFileSync(process.execPath, ['scripts/prepare-daily-release.mjs'], {
          cwd: root,
          env,
          encoding: 'utf8',
        })
          .trim()
          .split('\n')
          .at(-1),
      )
    const first = run()
    assert.equal(first.action, 'prepare')
    assert.equal(first.tag, 'opl-dsh-v0.2.22')
    assert.equal(git('rev-parse', 'HEAD'), first.sourceCommit)
    assert.ok(
      git('ls-remote', 'origin', 'refs/tags/opl-dsh-v0.2.22^{}').startsWith(first.sourceCommit),
    )
    const lock = JSON.parse(await readFile(join(root, 'package-lock.json')))
    assert.equal(lock.version, '0.2.22')
    assert.equal(lock.packages[''].version, '0.2.22')
    assert.ok((await readFile(output, 'utf8')).includes('tag=opl-dsh-v0.2.22'))
    const second = run()
    assert.equal(second.action, 'resume')
    assert.equal(second.sourceCommit, first.sourceCommit)
    assert.equal(git('status', '--porcelain'), '')
  },
)

test('Gateway flash failure falls through to luna before mechanical notes', async () => {
  const models = []
  const result = await writeDailyReleaseNotes(notesEvidence, {
    apiKey: 'gateway-secret',
    copilotToken: 'copilot-secret',
    copilot: async () => 'invalid',
    request: async (_url, options) => {
      const model = JSON.parse(options.body).model
      models.push(model)
      if (model === 'deepseek-flash') return new Response('', { status: 429 })
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                overview: '保留草稿。',
                changes: ['草稿不会被覆盖。'],
                limitations: [],
              }),
            },
          },
        ],
      })
    },
  })
  assert.equal(result.model, 'gpt-6-luna')
  assert.deepEqual(models, ['deepseek-flash', 'gpt-6-luna'])
})
