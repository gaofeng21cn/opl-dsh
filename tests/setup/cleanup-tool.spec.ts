import { describe, expect, it } from 'vitest'
// @ts-expect-error Installer JavaScript has no declaration file.
import {
  buildCleanupPlan,
  hashPlan,
  executeDshCleanup,
} from '../../installer/cleanup-skill/cleanup.mjs'

const sessions = [
  { id: 'a', path: 'sessions/a', active: false, taskRefs: [], lineageRefs: [] },
  { id: 'b', path: 'sessions/b', active: undefined, taskRefs: ['development'], lineageRefs: [] },
  { id: 'c', path: 'sessions/c', active: true, taskRefs: [], lineageRefs: [] },
]

describe('cleanup target selection', () => {
  it('protects active sessions and retained task references', () => {
    const plan = buildCleanupPlan({
      sessions,
      selector: { kind: 'ids', sessionIds: ['a', 'b', 'c'] },
    })
    expect(plan.targetSessionIds).toEqual(['a'])
    expect(plan.protectedSessionIds).toEqual(['b', 'c'])
    expect(plan.skipped).toEqual([
      { kind: 'session', id: 'b', reason: 'activity-unknown' },
      { kind: 'session', id: 'c', reason: 'session-active' },
    ])
  })
  it('allows terminal task references when the session is explicitly inactive', () => {
    const plan = buildCleanupPlan({
      sessions: [
        {
          id: 'terminal',
          path: 'sessions/terminal',
          active: false,
          taskRefs: ['done'],
          lineageRefs: [],
        },
      ],
      selector: { kind: 'ids', sessionIds: ['terminal'] },
    })
    expect(plan.targetSessionIds).toEqual(['terminal'])
  })
  it('uses the archive set and includes only the selected native owner records', () => {
    const plan = buildCleanupPlan({
      sessions,
      workspace: { archivedSessionIds: ['a'] },
      selector: { kind: 'archived' },
      externalRecords: [
        { id: 'ext-a', nativeSessionId: 'a', path: 'external/a.json', active: false },
        { id: 'ext-b', nativeSessionId: 'b', path: 'external/b.json', active: false },
      ],
    })
    expect(plan.targets.map((target: { id: string }) => target.id)).toEqual(['a', 'ext-a'])
  })
  it('does not delete an external record with an unknown native owner', () => {
    const plan = buildCleanupPlan({
      sessions,
      selector: { kind: 'ids', externalIds: ['orphan'] },
      externalRecords: [{ id: 'orphan', path: 'orphan.json', active: false }],
    })
    expect(plan.targets).toEqual([])
    expect(plan.skipped[0].reason).toBe('unknown-native-owner')
  })
  it('protects lineage crossing the selected set and honors exclusions', () => {
    const plan = buildCleanupPlan({
      sessions: sessions.map((session) =>
        session.id === 'a' ? { ...session, lineageRefs: ['b'] } : session,
      ),
      selector: { kind: 'ids', sessionIds: ['a', 'b'], excludeSessionIds: ['b'] },
    })
    expect(plan.targets).toEqual([])
    expect(plan.skipped[0].reason).toBe('retained-lineage-reference')
  })
  it('selects explicit workspace membership without deleting project files', () => {
    const plan = buildCleanupPlan({
      sessions,
      workspace: { workspaces: { w: { path: '/project', sessionIds: ['a'] } } },
      selector: { kind: 'workspaces', workspaceIds: ['w'] },
    })
    expect(plan.targets.map((target: { path: string }) => target.path)).toEqual(['sessions/a'])
  })
  it('rejects changed plans before filesystem operations', async () => {
    const plan = buildCleanupPlan({ sessions, selector: { kind: 'ids', sessionIds: ['a'] } })
    plan.targets[0].path = '/other'
    expect(hashPlan(plan)).not.toBe(plan.planHash)
    await expect(executeDshCleanup({ plan, expectedHash: plan.planHash })).rejects.toThrow(
      '计划已变化',
    )
  })
  it('rejects fuzzy and path-traversal selectors', () => {
    expect(() =>
      buildCleanupPlan({ sessions, selector: { kind: 'title', title: 'test' } }),
    ).toThrow()
    expect(() =>
      buildCleanupPlan({ sessions, selector: { kind: 'ids', sessionIds: ['../a'] } }),
    ).toThrow()
  })
})
