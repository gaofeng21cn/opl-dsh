// Explicit release qualification: pass a directory containing the two official alpha.2 providers.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import {
  previewCleanup,
  executeDshCleanup,
  restoreCleanup,
} from '../../installer/cleanup-skill/cleanup.mjs'
const require = createRequire(join(resolve(process.argv[2]), 'package.json'))
const load = (name) => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)).href)
const { Context } = await load('cordis')
const root = realpathSync.native(
  mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'opl-official-sqlite-')),
)
const home = join(root, 'data'),
  executable = join(root, 'fixture.exe'),
  a = 'test-source',
  b = 'test-fork'
writeFileSync(executable, '')
mkdirSync(join(home, 'storages'), { recursive: true })
writeFileSync(
  join(home, 'storages', 'workspace.json'),
  JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { workspaceIds: [], archivedSessionIds: [a], pinnedSessionIds: [] },
    tables: { workspaces: {} },
  }),
)
const provider = async (type, run) => {
  const plugin = await load('dsh-session-persistence-' + type)
  const ctx = new Context()
  const fiber = ctx.plugin(plugin, {
    root: join(home, 'sessions'),
    compression: 'zstd',
    listConcurrency: 3,
    frameEvents: 64,
  })
  await fiber.await()
  try {
    await run(ctx.sessionPersistence)
  } finally {
    await fiber.dispose()
  }
}
const header = (id) => ({ id, version: 4, isSeeded: false, createdAt: 1 })
const event = (seq, title) => ({
  seq,
  type: 'session/title',
  time: seq + 1,
  data: { title, messageSeqs: [], source: { kind: 'user' } },
})
await provider('jsonl', async (s) => {
  const h = await s.create(header(a))
  await h.append([event(0, 'legacy')])
  await h.flush()
  await h.close()
})
await provider('sqlite', async (s) => {
  const h = await s.open(a, 'write')
  await h.append([event(1, 'imported')])
  await h.flush()
  const prefix = (await h.read()).events
  await h.close()
  const c = await s.create(header(b), {
    parentSource: { sessionId: a, endSeq: 2, events: [...prefix, event(2, 'branch')] },
  })
  assert.equal((await c.read()).events.length, 3)
  await c.close()
})
const preview = () => previewCleanup({ home, executable, selector: { kind: 'archived' } })
let plan = await preview()
assert.deepEqual(plan.blockers, [])
assert.deepEqual(plan.targetSessionIds, [a])
let request = { plan, expectedHash: plan.planHash }
await provider('sqlite', async (s) => {
  const writer = await s.open(a, 'write')
  try {
    await assert.rejects(executeDshCleanup(request), /占用|写锁/)
  } finally {
    await writer.close()
  }
})
// A real POSIX writer updated the lock file since the preceding preview.
plan = await preview()
request = { plan, expectedHash: plan.planHash }
const result = await executeDshCleanup(request)
// Reconstruct the durable state just after a successful database commit and before route removal.
const journal = JSON.parse(readFileSync(result.journal, 'utf8'))
journal.indicesCommitted = false
writeFileSync(result.journal, JSON.stringify(journal))
const token = createHash('sha256').update(a).digest('hex')
writeFileSync(
  join(home, 'sessions', '.segments', token + '.json'),
  Buffer.from(plan.sqlite[0].route, 'base64'),
)
assert.equal((await executeDshCleanup({ ...request, resume: true })).verified, true)
await provider('sqlite', async (s) => {
  assert.deepEqual(
    (await s.list()).map((x) => x.header.id),
    [b],
  )
  const h = await s.open(b, 'write')
  assert.equal((await h.read()).events.at(-1).data.title, 'branch')
  await h.append([event(3, 'continued')])
  await h.flush()
  await h.close()
})
await restoreCleanup(request)
await provider('sqlite', async (s) => {
  assert.deepEqual((await s.list()).map((x) => x.header.id).sort(), [a, b].sort())
  for (const [id, titles] of [
    [a, ['legacy', 'imported']],
    [b, ['legacy', 'imported', 'branch', 'continued']],
  ]) {
    const h = await s.open(id, 'read')
    assert.deepEqual(
      (await h.read()).events.map((e) => e.data.title),
      titles,
    )
    await h.close()
  }
})
console.log(
  'PASS official alpha.2 JSONL creation, SQLite import and fork, busy-writer protection, interrupted recycle, retain+append, restore and reopen both histories',
)
rmSync(root, { recursive: true, force: true })
