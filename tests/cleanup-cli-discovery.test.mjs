import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const cli = fileURLToPath(new URL('../installer/cleanup-skill/cleanup.mjs', import.meta.url))
test('help does not need an installation or selector', () => {
  assert.match(
    execFileSync(process.execPath, [cli, 'preview', '--help'], { encoding: 'utf8' }),
    /--archived/,
  )
})
test(
  'Windows discovers both receipts and recycles only the unique exact title',
  { skip: process.platform !== 'win32' },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'opl-cleanup-accept-'))
    const home = join(root, 'profile'),
      suite = join(root, 'suite'),
      app = join(root, 'app')
    const put = (path, value) => writeFileSync(path, JSON.stringify(value))
    const env = { ...process.env, OPL_SUITE_ROOT: suite, OPL_DSH_HOME: home }
    const run = (...args) =>
      JSON.parse(
        execFileSync(process.execPath, [cli, ...args], {
          env,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      )
    const log = (id) => join(home, 'sessions/ns', id, 'session.v4.jsonl')
    const session = (id, title) =>
      writeFileSync(
        log(id),
        [
          { type: 'session', version: 4, id, isSeeded: false, createdAt: 1 },
          { type: 'session/title', data: { title } },
        ]
          .map((v) => JSON.stringify(v))
          .join('\n') + '\n',
      )
    try {
      for (const dir of [
        suite,
        app,
        join(home, 'opl-dsh'),
        join(home, 'storages'),
        join(home, 'profiles/desktop/harness-sessions'),
        join(home, 'sessions/ns/a'),
        join(home, 'sessions/ns/b'),
      ])
        mkdirSync(dir, { recursive: true })
      writeFileSync(join(app, 'DeepSeek Harness.exe'), '')
      const receipt = { profileHome: home, app, suiteVersion: 'fixture', cleanupSkillDir: root }
      put(join(suite, 'installation.json'), receipt)
      put(join(home, 'opl-dsh/installation.json'), { ...receipt, app: suite })
      assert.throws(() => run('preview', '--archived'), /安装回执不一致/)
      put(join(home, 'opl-dsh/installation.json'), receipt)
      const index = join(home, 'storages/workspace.json')
      put(index, {
        unit: { name: 'workspace', version: 2 },
        global: { workspaceIds: ['w'], archivedSessionIds: ['a'] },
        tables: { workspaces: { w: { sessionIds: ['a', 'b'] } } },
      })
      const dirty = join(home, 'sessions/.index-dirty')
      mkdirSync(dirty)
      const marker = join(dirty, 'session_3740274f-8190-4592-b87f-7f0df2dcb3d5.1795139144486')
      writeFileSync(marker, '')
      session('a', '同名')
      session('b', '同名')
      assert.throws(() => run('preview', '--title', '同名'), /标题未唯一匹配/)
      session('a', '甲')
      const retained = readFileSync(log('b'))
      const p = run('preview', '--title', '甲', '--plan', join(root, 'plan.json'))
      assert.equal(p.sessionCount, 2)
      assert.deepEqual(p.protectedSessionIds, ['b'])
      assert.deepEqual(p.targets, [{ kind: 'session', id: 'a' }])
      assert.deepEqual(p.blockers, [])
      for (const command of ['execute', 'verify'])
        assert.equal(run(command, '--plan', p.planFile, '--hash', p.planHash).verified, true)
      assert.equal(existsSync(marker), true)
      assert.equal(existsSync(log('a')), false)
      assert.deepEqual(readFileSync(log('b')), retained)
      assert.deepEqual(JSON.parse(readFileSync(index)).tables.workspaces.w.sessionIds, ['b'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)
