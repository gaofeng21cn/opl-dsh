// Explicit real recycle-bin smoke for disposable Windows/macOS profiles.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  mkdtempSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { zstdCompressSync } from 'node:zlib'
import {
  previewCleanup,
  executeDshCleanup,
  verifyCleanup,
  restoreCleanup,
} from '../../installer/cleanup-skill/cleanup.mjs'
const root = realpathSync.native(
  mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'opl-sqlite-recycle-')),
)
const home = join(root, 'data'),
  folder = join(home, 'sessions', '.segments')
const exec = join(root, process.platform === 'win32' ? 'fixture.exe' : 'fixture')
const dir = (id) => join(home, 'sessions', '_no-cwd', id)
const marker = (id) => join(folder, createHash('sha256').update(id).digest('hex') + '.json')
const file = join(folder, 'sessions.sqlite')
mkdirSync(folder, { recursive: true })
mkdirSync(join(home, 'storages'))
mkdirSync(join(home, 'profiles/desktop/harness-sessions'), { recursive: true })
writeFileSync(exec, '')
const ws = join(home, 'storages', 'workspace.json')
writeFileSync(
  ws,
  JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { workspaceIds: [], archivedSessionIds: ['a'], pinnedSessionIds: [] },
    tables: { workspaces: {} },
  }),
)
const db = new DatabaseSync(file)
db.exec(
  readFileSync(new URL('./fixtures/official-sqlite-v1.sql', import.meta.url), 'utf8').replaceAll(
    '\r\n',
    '\n',
  ),
)
db.exec('pragma journal_mode=WAL')
for (const [i, id] of ['a', 'b'].entries()) {
  mkdirSync(dir(id), { recursive: true })
  const header = { version: 4, id, isSeeded: false, createdAt: 1 }
  if (process.platform === 'darwin') writeFileSync(join(dir(id), 'session.lock'), '')
  if (!i)
    writeFileSync(
      join(dir(id), 'session.v4.jsonl'),
      JSON.stringify({ ...header, type: 'session' }) + '\n',
    )
  db.prepare('insert into segments values(?,?,?,?)').run(id, i ? 'a' : null, i ? 1 : null, i)
  db.prepare('insert into traces values(?,?,?,?)').run(id, JSON.stringify(header), id, i)
  const event = JSON.stringify({
    seq: i,
    time: 1,
    type: 'session/title',
    data: { title: 'SQL-' + id },
  })
  db.prepare('insert into frames values(?,?,?,?,?)').run(id, 0, 1, 1, zstdCompressSync(event))
  writeFileSync(marker(id), JSON.stringify({ id, database: file }) + '\n')
}
db.close()
const plan = await previewCleanup({ home, executable: exec, selector: { kind: 'archived' } })
assert.deepEqual(plan.blockers, [])
assert.deepEqual(plan.targetSessionIds, ['a'])
assert.deepEqual(plan.protectedSessionIds, ['b'])
assert.equal(plan.sessions.find((x) => x.id === 'a').title, 'SQL-a')
const req = { plan, expectedHash: plan.planHash }
const report = await executeDshCleanup(req)
assert.equal(report.verified, true)
assert.equal((await verifyCleanup(req)).verified, true)
assert.equal(existsSync(marker('a')), false)
assert.equal(existsSync(dir('a')), false)
const interim = new DatabaseSync(file)
assert.equal(interim.prepare('select count(*) n from traces').get().n, 1)
assert.equal(interim.prepare('select count(*) n from frames').get().n, 2)
interim.close()
const after = await previewCleanup({ home, executable: exec, selector: { kind: 'archived' } })
assert.deepEqual(after.blockers, [])
assert.deepEqual(
  after.sessions.map((x) => x.title),
  ['SQL-b'],
)
assert.equal((await restoreCleanup(req)).verified, true)
const restored = await previewCleanup({ home, executable: exec, selector: { kind: 'archived' } })
assert.deepEqual(restored.blockers, [])
assert.deepEqual(
  restored.sessions.map((x) => x.title),
  ['SQL-a', 'SQL-b'],
)
assert(existsSync(marker('a')))
console.log('PASS: SQLite mixed JSONL and shared prefix, exact recycle, reopen, restore, re-list')
rmSync(root, { recursive: true, force: true })
