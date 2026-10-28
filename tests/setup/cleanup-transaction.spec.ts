import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const io = vi.hoisted(() => ({ failAfterMove: false, moves: 0, receipts: new Map() }))
vi.mock('../../installer/cleanup-skill/windows-io.mjs', () => ({
  assertDesktopStopped: async () => {},
  assertSafePath: () => {},
  safeTree: (path: string) => tree(path),
  recycleTarget: async (target: { path: string }) => {
    const recycled = target.path + '.recycled-fixture'
    // The integration fixture moves outside the DSH home, just as the real recycler does.
    const destination = join(
      tmpdir(),
      'opl-receipt-' + createHash('sha256').update(target.path).digest('hex'),
    )
    renameSync(target.path, destination)
    io.moves++
    const receipt = { originalPath: target.path, recyclePath: destination, metadataPath: recycled }
    io.receipts.set(target.path, receipt)
    if (io.failAfterMove) {
      io.failAfterMove = false
      throw Error('interrupted after recycle')
    }
    return receipt
  },
  findRecycledTarget: async (target: { path: string }) => io.receipts.get(target.path),
  verifyRecycledTarget: (target: { tree: object }, receipt: { recyclePath: string }) => {
    expect(tree(receipt.recyclePath)).toEqual(target.tree)
  },
}))
// @ts-expect-error Installer JavaScript has no declaration file.
import {
  previewCleanup,
  executeDshCleanup,
  verifyCleanup,
} from '../../installer/cleanup-skill/cleanup.mjs'

function tree(path: string): Record<string, { bytes: number; sha256: string }> {
  if (statSync(path).isFile()) {
    const bytes = readFileSync(path)
    return {
      '.': { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
    }
  }
  return Object.fromEntries(
    readdirSync(path).map((name) => {
      const bytes = readFileSync(join(path, name))
      return [
        name,
        { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
      ]
    }),
  )
}
const homes: string[] = []
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'opl-cleanup-transaction-'))
  homes.push(home)
  mkdirSync(join(home, 'storages'), { recursive: true })
  mkdirSync(join(home, 'profiles/desktop/harness-sessions'), { recursive: true })
  for (const id of ['a', 'b']) {
    mkdirSync(join(home, 'sessions/ns', id), { recursive: true })
    writeFileSync(
      join(home, 'sessions/ns', id, 'session.v4.jsonl'),
      JSON.stringify({ type: 'session', version: 4, id, createdAt: 1, isSeeded: false }) + '\n',
    )
  }
  writeFileSync(
    join(home, 'storages/workspace.json'),
    JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { workspaceIds: ['w'], archivedSessionIds: ['a'], pinnedSessionIds: [] },
      tables: { workspaces: { w: { sessionIds: ['a', 'b'] } } },
    }),
  )
  writeFileSync(
    join(home, 'profiles/desktop/harness-sessions/ext-a.json'),
    JSON.stringify({ id: 'ext-a', nativeSessionId: 'a' }),
  )
  return home
}
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  for (const receipt of io.receipts.values())
    rmSync(receipt.recyclePath, { recursive: true, force: true })
  io.receipts.clear()
  io.moves = 0
  io.failAfterMove = false
})
describe('offline cleanup transaction', () => {
  it('refuses new reference stores when resuming a partial recycle', async () => {
    const home = fixture()
    const plan = await previewCleanup({
      home,
      executable: join(home, 'desktop.exe'),
      selector: { kind: 'archived' },
    })
    io.failAfterMove = true
    await expect(executeDshCleanup({ plan, expectedHash: plan.planHash })).rejects.toThrow(
      'interrupted',
    )
    writeFileSync(join(home, 'profiles/desktop/combination-selection.json'), '{"a":"dsh"}')
    await expect(
      executeDshCleanup({ plan, expectedHash: plan.planHash, resume: true }),
    ).rejects.toThrow('引用索引集合已变化')
    expect(io.moves).toBe(1)
    expect(existsSync(join(home, 'profiles/desktop/harness-sessions/ext-a.json'))).toBe(true)
  })
  it('removes target indices and preserves unarchived data', async () => {
    const home = fixture()
    const plan = await previewCleanup({
      home,
      executable: join(home, 'desktop.exe'),
      selector: { kind: 'archived' },
    })
    expect(plan.blockers).toEqual([])
    const retained = readFileSync(join(home, 'sessions/ns/b/session.v4.jsonl'))
    const result = await executeDshCleanup({ plan, expectedHash: plan.planHash })
    expect(result.verified).toBe(true)
    expect(io.moves).toBe(2)
    expect(existsSync(join(home, 'sessions/ns/a'))).toBe(false)
    expect(readFileSync(join(home, 'sessions/ns/b/session.v4.jsonl'))).toEqual(retained)
    const workspace = JSON.parse(readFileSync(join(home, 'storages/workspace.json'), 'utf8'))
    expect(workspace.global.archivedSessionIds).toEqual([])
    expect(workspace.tables.workspaces.w.sessionIds).toEqual(['b'])
  })
  it('resumes an interrupted move without repeating it or losing its receipt', async () => {
    const home = fixture()
    const plan = await previewCleanup({
      home,
      executable: join(home, 'desktop.exe'),
      selector: { kind: 'archived' },
    })
    io.failAfterMove = true
    await expect(executeDshCleanup({ plan, expectedHash: plan.planHash })).rejects.toThrow(
      'interrupted',
    )
    expect(io.moves).toBe(1)
    await executeDshCleanup({ plan, expectedHash: plan.planHash, resume: true })
    expect(io.moves).toBe(2)
    expect((await verifyCleanup({ plan, expectedHash: plan.planHash })).verified).toBe(true)
  })
  it('refuses a changed protected file before recycling anything', async () => {
    const home = fixture()
    const plan = await previewCleanup({
      home,
      executable: join(home, 'desktop.exe'),
      selector: { kind: 'archived' },
    })
    writeFileSync(join(home, 'sessions/ns/b/session.v4.jsonl'), 'changed')
    await expect(executeDshCleanup({ plan, expectedHash: plan.planHash })).rejects.toThrow(
      '快照已变化',
    )
    expect(io.moves).toBe(0)
  })
})
