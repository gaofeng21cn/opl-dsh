import { describe, expect, it } from 'vitest'
import { liveTranscriptDefinition as definition } from '../../src/execution/client/live-transcript.ts'
import { HARNESS_TRANSCRIPT_TOOL } from '../../src/execution/contracts/tool-display.ts'

// Public definition callbacks replay the same Session events used by Desktop qualification.
function conversation() {
  let seq = 0
  let state: any
  let current: any
  let official: any = { status: 'running', blocks: [] }
  const matches: any[] = []
  const step: any = { status: 'open', data: { get: () => official } }
  const context = () => ({
    key: 'live:1:1',
    id: '1:1',
    matches,
    start: matches[0],
    state,
    current: new Map(current ? [['chat', current]] : []),
  })
  function event(type: string, data: Record<string, unknown> = {}) {
    const event: any = { type, seq: ++seq, time: seq, data: { turn: 1, step: 1, ...data } }
    const match = definition.match(event)
    if (!match) return false
    const input: any = { ...match, event, location: { kind: 'step', turn: 1, step } }
    matches.push(input)
    state =
      state === undefined
        ? definition.start(context(), input, {} as any)
        : definition.update({ ...context(), state }, input)
    current = definition.buildViewNode!(context())
    return true
  }
  return {
    event,
    get node() {
      return current
    },
    official(value: any) {
      official = value
    },
    close() {
      step.status = 'closed'
    },
  }
}
const thought = (text: string) => ({ chunk: { type: 'reasoning-delta', index: 0, text } })
const toolFinal = { status: 'settled', blocks: [{ kind: 'tool-call' }] }

describe('live external transcript in the ordinary conversation', () => {
  it('shows growing real reasoning after a tool-only assistant settlement', () => {
    const c = conversation()
    c.event('step/start')
    c.event('assistant/live-chunk', thought('Before tool. '))
    expect(c.node).toBeNull()
    c.official(toolFinal)
    c.event('tool/call', { name: HARNESS_TRANSCRIPT_TOOL })
    expect(c.node).toMatchObject({
      visibility: 'visible',
      location: { kind: 'session' },
      data: {
        blocks: [{ type: 'reasoning', text: 'Before tool. ' }],
      },
    })
    c.event('assistant/live-chunk', thought('After tool.'))
    expect(c.node.data.blocks[0].text).toBe('Before tool. After tool.')
    c.event('assistant/live-chunk', { chunk: { type: 'text-delta', index: 1, text: 'Working.' } })
    expect(c.node.data.blocks[1]).toEqual({ type: 'text', text: 'Working.' })
    c.official({ status: 'settled', blocks: [{ kind: 'reasoning', text: 'Final thought' }] })
    c.event('assistant/message')
    expect(c.node.visibility).toBe('hidden')
  })
  it('recovers from a live snapshot and hides on step closure', () => {
    const c = conversation()
    c.official(toolFinal)
    c.event('step/start')
    c.event('tool/call', { name: HARNESS_TRANSCRIPT_TOOL })
    c.event('assistant/live-chunk', {
      chunk: { type: 'block-start', index: 0, blockType: 'reasoning' },
    })
    c.event('assistant/live-chunk', thought('Reloaded live thought.'))
    expect(c.node.data.blocks[0].text).toBe('Reloaded live thought.')
    c.event('assistant/live-chunk', {
      chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Complete block.' } },
    })
    expect(c.node.data.blocks[0].text).toBe('Complete block.')
    c.close()
    c.event('step/end')
    expect(c.node.visibility).toBe('hidden')
  })
  it('leaves ordinary tools and official live-capable projections alone', () => {
    const c = conversation()
    c.official(toolFinal)
    c.event('step/start')
    expect(c.event('tool/call', { name: 'bash' })).toBe(false)
    c.event('assistant/live-chunk', thought('Ordinary thought.'))
    expect(c.node).toBeNull()
    c.event('tool/call', { name: HARNESS_TRANSCRIPT_TOOL })
    expect(c.node.visibility).toBe('visible')
    c.official({ status: 'running', blocks: [{ kind: 'reasoning', text: 'Ordinary thought.' }] })
    c.event('assistant/live-chunk', thought(' More.'))
    expect(c.node.visibility).toBe('hidden')
  })
  it('clears a previous attempt and never turns tool JSON into thinking', () => {
    const c = conversation()
    c.official(toolFinal)
    c.event('step/start')
    c.event('tool/call', { name: HARNESS_TRANSCRIPT_TOOL })
    c.event('assistant/live-chunk', thought('Old attempt.'))
    c.event('assistant/attempt')
    expect(c.node.visibility).toBe('hidden')
    c.event('assistant/live-chunk', {
      chunk: { type: 'tool-input-delta', index: 1, text: 'SECRET_TOOL_ARGS' },
    })
    expect(c.node.visibility).toBe('hidden')
    c.event('assistant/live-chunk', thought('New attempt.'))
    expect(c.node.data.blocks).toEqual([{ type: 'reasoning', text: 'New attempt.' }])
  })
})
