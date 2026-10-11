/**
 * Pure presentation tests for the read-only todo panel.
 *
 * The matrix covers every recorded status against every Session activity, the
 * frozen-input guarantee, the empty projection, the recorded-status counts, and
 * the child reducer — including the case that must never be invented: a child
 * whose status cannot be read is unknown, not stopped.
 */
import { describe, expect, it } from 'vitest'
import type { SubagentCatalogEntry } from '@deepseek-ai/dsh-subagent/client'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo/client'
import {
  childActivity,
  childActivityLabelKey,
  projectTodoPanel,
  sessionActivity,
  todoRowState,
  type SessionActivity,
} from '../../src/todo-status/client/todo-display.ts'

const ACTIVITIES: SessionActivity[] = ['running', 'stopped', 'unknown']
const STATUSES: TodoItem['status'][] = ['pending', 'in_progress', 'completed']

function child(id: string): SubagentCatalogEntry {
  return { id: id as SubagentCatalogEntry['id'], createdAt: 0, mode: 'one-shot' }
}

function todos(): TodoItem[] {
  return [
    { content: 'Read the log', status: 'completed' },
    { content: 'Write the panel', status: 'in_progress' },
    { content: 'Ship it', status: 'pending' },
  ]
}

/** Deep-freeze a todo list so any write by the projection throws. */
function frozen(list: TodoItem[]): readonly TodoItem[] {
  for (const item of list) Object.freeze(item)
  return Object.freeze(list)
}

describe('session activity', () => {
  it('classifies only a known boolean, and keeps unknown separate from stopped', () => {
    expect(sessionActivity(true)).toBe('running')
    expect(sessionActivity(false)).toBe('stopped')
    expect(sessionActivity(undefined)).toBe('unknown')
  })
})

describe('row presentation', () => {
  it('never turns anything but a recorded completed into done', () => {
    for (const status of STATUSES) {
      for (const activity of ACTIVITIES) {
        const row = todoRowState(status, activity)
        expect(row.dot === 'done').toBe(status === 'completed')
        expect(row.display === 'done').toBe(status === 'completed')
      }
    }
  })

  it('keeps the recorded status visible in every context and never spins after a stop', () => {
    for (const status of STATUSES) {
      for (const activity of ACTIVITIES) {
        const row = todoRowState(status, activity)
        if (activity !== 'running') expect(row.dot).not.toBe('ongoing')
        if (status === 'in_progress' && activity === 'stopped') {
          expect(row.dot).toBe('warning')
          expect(row.labelKey).toBe('statusUnfinished')
          expect(row.unfinished).toBe(true)
        }
        if (status === 'in_progress' && activity === 'unknown') {
          expect(row.dot).toBe('warning')
          expect(row.labelKey).toBe('statusUnfinishedUnknown')
        }
        if (status === 'pending') expect(row.labelKey).toBe('statusPending')
        if (status === 'completed') expect(row.unfinished).toBe(false)
      }
    }
  })
})

describe('panel projection', () => {
  it('renders nothing for an absent or empty projection', () => {
    const children = childActivity([], () => false)
    for (const value of [null, undefined, []]) {
      expect(projectTodoPanel(value, true, children).rows).toEqual([])
      expect(projectTodoPanel(value, false, children).rows).toEqual([])
    }
  })

  it('keeps every item, in order, with its recorded status untouched', () => {
    const input = frozen(todos())
    const view = projectTodoPanel(
      input,
      false,
      childActivity([], () => false),
    )
    expect(view.rows.map((row) => row.content)).toEqual(todos().map((item) => item.content))
    expect(view.rows.map((row) => row.status)).toEqual(['completed', 'in_progress', 'pending'])
    expect(view.rows.map((row) => row.display)).toEqual(['done', 'unfinished', 'pending'])
    expect(view.rows.map((row) => row.dot)).toEqual(['done', 'warning', 'idle'])
  })

  it('does not write to the projection it reads', () => {
    const input = frozen(todos())
    const before = JSON.stringify(input)
    const view = projectTodoPanel(input, true, childActivity(undefined, undefined))
    expect(JSON.stringify(input)).toBe(before)
    for (const item of input) expect(Object.isFrozen(item)).toBe(true)
    expect(view.rows.every((row) => typeof row.content === 'string')).toBe(true)
  })

  it('counts the recorded statuses, not the display kinds', () => {
    const view = projectTodoPanel(
      frozen(todos()),
      false,
      childActivity([], () => false),
    )
    expect(view.counts).toEqual({ completed: 1, inProgress: 1, pending: 1 })
    expect(view.unfinished).toBe(2)
    expect(view.activity).toBe('stopped')
    expect(view.showStoppedNote).toBe(true)
  })

  it('shows the stopped note only while work remains in a stopped Session', () => {
    const done: TodoItem[] = [{ content: 'Only one', status: 'completed' }]
    expect(
      projectTodoPanel(
        done,
        false,
        childActivity([], () => false),
      ).showStoppedNote,
    ).toBe(false)
    expect(
      projectTodoPanel(
        todos(),
        true,
        childActivity([], () => false),
      ).showStoppedNote,
    ).toBe(false)
    expect(
      projectTodoPanel(
        todos(),
        undefined,
        childActivity([], () => false),
      ).showStoppedNote,
    ).toBe(false)
    expect(
      projectTodoPanel(
        todos(),
        false,
        childActivity([], () => false),
      ).showStoppedNote,
    ).toBe(true)
  })

  it('keeps one row per item even when two items repeat their text', () => {
    const repeated: TodoItem[] = [
      { content: 'same', status: 'pending' },
      { content: 'same', status: 'completed' },
    ]
    const view = projectTodoPanel(
      repeated,
      true,
      childActivity([], () => false),
    )
    expect(view.rows).toHaveLength(2)
    expect(new Set(view.rows.map((row) => row.key)).size).toBe(2)
  })
})

describe('child activity', () => {
  it('reports an unreadable catalogue as unavailable, never as no children', () => {
    expect(childActivity(undefined, () => false)).toEqual({
      kind: 'unavailable',
      total: 0,
      running: 0,
      unknown: 0,
    })
  })

  it('reports an empty catalogue as none', () => {
    expect(childActivity([], undefined).kind).toBe('none')
  })

  it('reads each child: running, known idle, and unknown', () => {
    const catalog = [child('a'), child('b'), child('c')]
    expect(
      childActivity(catalog, (id) => (id === 'a' ? true : id === 'b' ? false : undefined)),
    ).toEqual({ kind: 'running', total: 3, running: 1, unknown: 1 })
    expect(childActivity(catalog, () => false)).toEqual({
      kind: 'idle',
      total: 3,
      running: 0,
      unknown: 0,
    })
    expect(childActivity(catalog, () => undefined).kind).toBe('unknown')
    expect(childActivity(catalog, undefined).kind).toBe('unknown')
    expect(childActivity(catalog, (id) => (id === 'c' ? undefined : false)).kind).toBe('unknown')
  })

  it('maps every kind to a sentence, and none to nothing', () => {
    expect(childActivityLabelKey('none')).toBeUndefined()
    expect(childActivityLabelKey('running')).toBe('childRunning')
    expect(childActivityLabelKey('idle')).toBe('childIdle')
    expect(childActivityLabelKey('unknown')).toBe('childUnknown')
    expect(childActivityLabelKey('unavailable')).toBe('childUnavailable')
  })

  it('never maps live children onto a todo row', () => {
    const input = frozen(todos())
    const quiet = projectTodoPanel(
      input,
      false,
      childActivity([child('a')], () => false),
    )
    const busy = projectTodoPanel(
      input,
      false,
      childActivity([child('a')], () => true),
    )
    const lost = projectTodoPanel(input, false, childActivity(undefined, undefined))
    expect(busy.rows).toEqual(quiet.rows)
    expect(lost.rows).toEqual(quiet.rows)
    expect(quiet.counts).toEqual(busy.counts)
    expect(busy.children.kind).toBe('running')
    expect(lost.children.kind).toBe('unavailable')
  })
})
