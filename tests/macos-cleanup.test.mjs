import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  closeSync,
  constants,
  openSync,
  rmSync,
  readdirSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'

test(
  'macOS cleanup CLI recycles only archived sessions in a disposable user home',
  { skip: process.platform !== 'darwin' },
  () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'opl-trash-ci-')))
    try {
      const home = join(root, 'profile')
      const trash = join(root, '.Trash')
      mkdirSync(trash)
      const executable = join(root, 'Desktop')
      writeFileSync(executable, '')
      const records = (id) => join(home, 'sessions/ns', id, 'session.v4.jsonl.zstd')
      for (const id of ['a', 'b']) {
        mkdirSync(join(home, 'sessions/ns', id), { recursive: true })
        writeFileSync(join(home, 'sessions/ns', id, 'session.lock'), '')
        writeFileSync(
          records(id),
          Buffer.concat(
            [
              { type: 'session', version: 4, id, createdAt: 1, isSeeded: false },
              { type: 'session/title', data: { title: '聊天-' + id } },
            ].map((row) => zstdCompressSync(Buffer.from(JSON.stringify(row) + '\n'))),
          ),
        )
      }
      mkdirSync(join(home, 'storages'))
      mkdirSync(join(home, 'profiles/desktop/harness-sessions'), { recursive: true })
      const index = join(home, 'storages/workspace.json')
      writeFileSync(
        index,
        JSON.stringify({
          unit: { name: 'workspace', version: 2 },
          global: { workspaceIds: ['w'], archivedSessionIds: ['a'], pinnedSessionIds: [] },
          tables: { workspaces: { w: { sessionIds: ['a', 'b'] } } },
        }),
      )
      const selector = join(root, 'selector.json'),
        plan = join(root, 'plan.json')
      writeFileSync(selector, JSON.stringify({ kind: 'archived' }))
      const cli = fileURLToPath(new URL('../installer/cleanup-skill/cleanup.mjs', import.meta.url))
      const run = (...args) =>
        JSON.parse(
          execFileSync(process.execPath, [cli, ...args], {
            encoding: 'utf8',
            env: { ...process.env, HOME: root },
          }),
        )
      const retained = readFileSync(records('b'))
      const preview = run(
        'preview',
        '--home',
        home,
        '--executable',
        executable,
        '--selector-file',
        selector,
        '--plan',
        plan,
      )
      assert.deepEqual(preview.blockers, [])
      assert.deepEqual(preview.protectedSessionIds, ['b'])
      assert.equal(preview.sessions.find((s) => s.id === 'a').title, '聊天-a')
      const fd = openSync(join(home, 'sessions/ns/a/session.lock'), 0x20 | constants.O_NONBLOCK)
      try {
        assert.throws(
          () => run('execute', '--plan', plan, '--hash', preview.planHash),
          /会话仍被占用/,
        )
        assert.equal(existsSync(records('a')), true)
      } finally {
        closeSync(fd)
      }
      for (const command of ['execute', 'verify'])
        assert.equal(run(command, '--plan', plan, '--hash', preview.planHash).verified, true)
      assert.equal(existsSync(records('a')), false)
      assert.deepEqual(readFileSync(records('b')), retained)
      assert.deepEqual(JSON.parse(readFileSync(index)).tables.workspaces.w.sessionIds, ['b'])
      assert.equal(readdirSync(trash).length, 1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)
