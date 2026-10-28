import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
// @ts-expect-error The cleanup skill is a JavaScript artifact without declarations.
import { loadDshSnapshot } from '../../installer/cleanup-skill/snapshot.mjs'

function homeFixture() {
  const home = mkdtempSync(join(tmpdir(), 'opl-cleanup-snapshot-'))
  mkdirSync(join(home, 'storages'), { recursive: true })
  mkdirSync(join(home, 'sessions', 'ns', 'a'), { recursive: true })
  mkdirSync(join(home, 'sessions', 'ns', 'b'), { recursive: true })
  mkdirSync(join(home, 'profiles', 'desktop', 'harness-sessions'), { recursive: true })
  writeFileSync(
    join(home, 'storages', 'workspace.json'),
    JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { workspaceIds: ['w'], archivedSessionIds: ['a'], pinnedSessionIds: [] },
      tables: {
        workspaces: { w: { path: '/tmp/project', title: 'project', sessionIds: ['a', 'b'] } },
      },
    }),
  )
  return home
}

function writeSession(home: string, id: string, frames: string[]) {
  const bytes = Buffer.concat(frames.map((frame) => zstdCompressSync(Buffer.from(frame))))
  writeFileSync(join(home, 'sessions', 'ns', id, 'session.v4.jsonl.zstd'), bytes)
}

describe('read-only DSH cleanup snapshot', () => {
  it('resolves exact IDs and hashes only selected trees, including later zstd frames', async () => {
    const home = homeFixture()
    try {
      writeSession(home, 'a', [
        '{"type":"session","version":4,"id":"a","createdAt":1,"isSeeded":false}\n',
        '{"type":"event","id":"a","payload":"later frame"}\n',
      ])
      writeSession(home, 'b', [
        '{"type":"session","version":4,"id":"b","createdAt":1,"isSeeded":false}\n',
      ])
      writeFileSync(
        join(home, 'profiles', 'desktop', 'harness-sessions', 'migration-complete.json'),
        '{"version":1}\n',
      )
      const snapshot = await loadDshSnapshot({
        home,
        selector: { kind: 'ids', sessionIds: ['a', 'b'], excludeSessionIds: ['b'] },
      })
      const a = snapshot.sessions.find((session: any) => session.id === 'a')
      const b = snapshot.sessions.find((session: any) => session.id === 'b')
      expect(a.tree['session.v4.jsonl.zstd'].bytes).toBeGreaterThan(0)
      expect(a.tree['session.v4.jsonl.zstd'].sha256).toBe(
        createHash('sha256')
          .update(
            Buffer.concat([
              zstdCompressSync(
                Buffer.from(
                  '{"type":"session","version":4,"id":"a","createdAt":1,"isSeeded":false}\n',
                ),
              ),
              zstdCompressSync(Buffer.from('{"type":"event","id":"a","payload":"later frame"}\n')),
            ]),
          )
          .digest('hex'),
      )
      expect(b.tree).toBeUndefined()
      expect(snapshot.stats.targetHashBytes).toBe(a.tree['session.v4.jsonl.zstd'].bytes)
      expect(snapshot.indices).toHaveLength(1)
      expect(snapshot.blockers).toEqual([])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('closes an external selection over its native session and reports structured references', async () => {
    const home = homeFixture()
    try {
      writeSession(home, 'a', [
        '{"type":"session","version":4,"id":"a","createdAt":1,"isSeeded":false}\n',
      ])
      writeSession(home, 'b', [
        '{"type":"session","version":4,"id":"b","createdAt":1,"isSeeded":false}\n',
      ])
      writeFileSync(
        join(home, 'profiles', 'desktop', 'harness-sessions', 'record.json'),
        JSON.stringify({ id: 'ext-a', nativeSessionId: 'a' }),
      )
      writeFileSync(
        join(home, 'profiles', 'desktop', 'combination-selection.json'),
        JSON.stringify({ a: 'dsh' }),
      )
      const snapshot = await loadDshSnapshot({
        home,
        selector: { kind: 'ids', sessionIds: [], externalIds: ['ext-a'] },
      })
      expect(snapshot.sessions.find((session: any) => session.id === 'a')?.tree).toBeDefined()
      expect(snapshot.sessions.find((session: any) => session.id === 'b')?.tree).toBeUndefined()
      expect(snapshot.externalRecords[0].tree).toBeDefined()
      expect(snapshot.sessions.find((session: any) => session.id === 'a')?.taskRefs).toEqual([])
      expect(
        snapshot.indices.some((item: any) => item.path.endsWith('combination-selection.json')),
      ).toBe(true)
      expect(snapshot.blockers).toEqual([])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('keeps a malformed selected header protected instead of dropping it', async () => {
    const home = homeFixture()
    try {
      writeSession(home, 'a', ['not-json\n'])
      const snapshot = await loadDshSnapshot({ home, selector: { kind: 'ids', sessionIds: ['a'] } })
      const a = snapshot.sessions.find((session: any) => session.id === 'a')
      expect(a?.tree).toBeUndefined()
      expect(a?.blockers).toContain('session-header-malformed')
      expect(
        snapshot.blockers.some(
          (item: any) => item.code === 'session-header-malformed' && item.id === 'a',
        ),
      ).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('treats legacy session_ directories as opaque protected data', async () => {
    const home = homeFixture()
    try {
      mkdirSync(join(home, 'sessions', 'ns', 'session_legacy'), { recursive: true })
      writeFileSync(join(home, 'sessions', 'ns', 'session_legacy', 'opaque.bin'), 'protected')
      const snapshot = await loadDshSnapshot({
        home,
        selector: { kind: 'ids', sessionIds: ['session_legacy'] },
      })
      const legacy = snapshot.sessions.find((session: any) => session.id === 'session_legacy')
      expect(legacy?.legacy).toBe(true)
      expect(legacy?.tree).toBeUndefined()
      expect(legacy?.blockers).toContain('legacy-session-directory')
      expect(snapshot.blockers.some((item: any) => item.code === 'legacy-session-directory')).toBe(
        true,
      )
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('reads a dependency in a later concatenated zstd frame and blocks malformed later rows', async () => {
    const home = homeFixture()
    try {
      writeSession(home, 'a', [
        '{"type":"session","version":4,"id":"a","createdAt":1,"isSeeded":false}\n',
        '{"type":"event","origin":{"sessionId":"b"}}\n',
      ])
      writeSession(home, 'b', [
        '{"type":"session","version":4,"id":"b","createdAt":1,"isSeeded":false}\n',
      ])
      const snapshot = await loadDshSnapshot({ home, selector: { kind: 'ids', sessionIds: ['a'] } })
      expect(snapshot.sessions.find((session: any) => session.id === 'a')?.lineageRefs).toContain(
        'b',
      )
      writeSession(home, 'a', [
        '{"type":"session","version":4,"id":"a","createdAt":1,"isSeeded":false}\n',
        '{invalid\n',
      ])
      const malformed = await loadDshSnapshot({
        home,
        selector: { kind: 'ids', sessionIds: ['a'] },
      })
      expect(
        malformed.blockers.some((item: any) => item.code === 'selected-session-log-invalid'),
      ).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('hashes external mappings when the native ID is selected and preserves every file byte', async () => {
    const home = homeFixture()
    try {
      writeSession(home, 'a', [
        '{"type":"session","version":4,"id":"a","createdAt":1,"isSeeded":false}\n',
      ])
      writeSession(home, 'b', [
        '{"type":"session","version":4,"id":"b","createdAt":1,"isSeeded":false}\n',
      ])
      const externalPath = join(home, 'profiles', 'desktop', 'harness-sessions', 'record.json')
      writeFileSync(externalPath, JSON.stringify({ id: 'ext-a', nativeSessionId: 'a' }))
      const before = readFileSync(externalPath)
      const snapshot = await loadDshSnapshot({ home, selector: { kind: 'ids', sessionIds: ['a'] } })
      expect(snapshot.externalRecords[0].tree['.']).toEqual({
        bytes: before.length,
        sha256: createHash('sha256').update(before).digest('hex'),
      })
      expect(snapshot.externalRecords[0].active).toBe(false)
      expect(readFileSync(externalPath)).toEqual(before)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('uses exact workspace and archive membership and applies native exclusions to external closure', async () => {
    const home = homeFixture()
    try {
      writeSession(home, 'a', [
        '{"type":"session","version":4,"id":"a","createdAt":1,"isSeeded":false}\n',
      ])
      writeSession(home, 'b', [
        '{"type":"session","version":4,"id":"b","createdAt":1,"isSeeded":false}\n',
      ])
      writeFileSync(
        join(home, 'profiles', 'desktop', 'harness-sessions', 'record.json'),
        JSON.stringify({ id: 'ext-b', nativeSessionId: 'b' }),
      )
      const archived = await loadDshSnapshot({ home, selector: { kind: 'archived' } })
      expect(
        archived.sessions.filter((session: any) => session.tree).map((session: any) => session.id),
      ).toEqual(['a'])
      const workspace = await loadDshSnapshot({
        home,
        selector: { kind: 'workspaces', workspaceIds: ['w'], excludeSessionIds: ['b'] },
      })
      expect(
        workspace.sessions.filter((session: any) => session.tree).map((session: any) => session.id),
      ).toEqual(['a'])
      expect(workspace.externalRecords[0].tree).toBeUndefined()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('blocks task-linked and edit-linked native sessions using structured records only', async () => {
    const home = homeFixture()
    try {
      writeSession(home, 'a', [
        '{"type":"session","version":4,"id":"a","createdAt":1,"isSeeded":false}\n',
      ])
      writeSession(home, 'b', [
        '{"type":"session","version":4,"id":"b","createdAt":1,"isSeeded":false}\n',
      ])
      writeFileSync(
        join(home, 'storages', 'task_feedback.json'),
        JSON.stringify({
          unit: { name: 'task_feedback', version: 1 },
          global: { deliveryCount: 0 },
          tables: {
            tasks: { task1: { taskId: 'task1', sessionId: 'a', state: 'completed' } },
            outbox: {},
            receipts: {},
          },
        }),
      )
      mkdirSync(join(home, 'profiles', 'desktop', 'message-edit-intents'), { recursive: true })
      writeFileSync(
        join(home, 'profiles', 'desktop', 'message-edit-intents', 'intent.json'),
        JSON.stringify({ input: { prompt: { sessionId: 'b' } } }),
      )
      const snapshot = await loadDshSnapshot({ home, selector: { kind: 'archived' } })
      expect(snapshot.sessions.find((session: any) => session.id === 'a')?.taskRefs).toContain(
        'task1',
      )
      expect(snapshot.sessions.find((session: any) => session.id === 'a')?.active).toBe(false)
      expect(snapshot.sessions.find((session: any) => session.id === 'b')?.blockers).toContain(
        'edit-intent-reference:message-edit-intents',
      )
      expect(snapshot.indices).toHaveLength(3)
      writeFileSync(
        join(home, 'storages', 'task_feedback.json'),
        JSON.stringify({
          unit: { name: 'task_feedback', version: 1 },
          global: { deliveryCount: 0 },
          tables: {
            tasks: { task2: { taskId: 'task2', sessionId: 'a', state: 'running' } },
            outbox: {},
            receipts: {},
          },
        }),
      )
      const active = await loadDshSnapshot({ home, selector: { kind: 'ids', sessionIds: ['a'] } })
      expect(active.sessions.find((session: any) => session.id === 'a')?.active).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('rejects selector traversal, duplicate directory IDs, and linked ancestors', async () => {
    const home = homeFixture()
    const linkHome = `${home}-link`
    try {
      await expect(
        loadDshSnapshot({ home, selector: { kind: 'ids', sessionIds: ['../a'] } }),
      ).rejects.toThrow('unsafe ID')
      writeSession(home, 'a', [
        '{"type":"session","version":4,"id":"a","createdAt":1,"isSeeded":false}\n',
      ])
      mkdirSync(join(home, 'sessions', 'second', 'a'), { recursive: true })
      writeFileSync(
        join(home, 'sessions', 'second', 'a', 'session.jsonl'),
        '{"type":"session","version":4,"id":"a","createdAt":1,"isSeeded":false}\n',
      )
      await expect(
        loadDshSnapshot({ home, selector: { kind: 'ids', sessionIds: ['a'] } }),
      ).rejects.toThrow('duplicate native session')
      symlinkSync(home, linkHome, process.platform === 'win32' ? 'junction' : 'dir')
      await expect(
        loadDshSnapshot({ home: linkHome, selector: { kind: 'ids', sessionIds: ['a'] } }),
      ).rejects.toThrow(/link|reparse/)
    } finally {
      rmSync(linkHome, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('retains a parent referenced by a later row in an unselected session', async () => {
    const home = homeFixture()
    try {
      writeSession(home, 'a', [
        '{"type":"session","version":4,"id":"a","createdAt":1,"isSeeded":false}\n',
      ])
      writeSession(home, 'b', [
        '{"type":"session","version":4,"id":"b","createdAt":1,"isSeeded":false}\n',
        '{"type":"event","origin":{"sessionId":"a"}}\n',
      ])
      const snapshot = await loadDshSnapshot({ home, selector: { kind: 'ids', sessionIds: ['a'] } })
      expect(snapshot.sessions.find((session: any) => session.id === 'a')?.lineageRefs).toContain(
        'b',
      )
      expect(snapshot.blockers).toEqual([])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('blocks cleanup when an unselected log is malformed and may hide a reference', async () => {
    const home = homeFixture()
    try {
      writeSession(home, 'a', [
        '{"type":"session","version":4,"id":"a","createdAt":1,"isSeeded":false}\n',
      ])
      writeSession(home, 'b', [
        '{"type":"session","version":4,"id":"b","createdAt":1,"isSeeded":false}\n',
        '{broken\n',
      ])
      const snapshot = await loadDshSnapshot({ home, selector: { kind: 'ids', sessionIds: ['a'] } })
      expect(
        snapshot.blockers.some((item: any) => item.code === 'selected-session-log-invalid'),
      ).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
