import { describe, expect, it } from 'vitest'
import { createPiAdapter } from '../../src/execution/host/adapters/pi/pi.ts'
import { createStepCodeAdapter } from '../../src/execution/host/adapters/step/step.ts'
import { createMuseCodeAdapter } from '../../src/execution/host/adapters/muse/muse.ts'

for (const adapter of [
  createPiAdapter('pi-bridge.mjs'),
  createStepCodeAdapter('step-bridge.mjs'),
  createMuseCodeAdapter('muse-bridge.mjs'),
]) {
  describe(`${adapter.id} reported completion`, () => {
    it('refuses a turn with no answer even when a tool failed', () => {
      expect(
        adapter.acceptResult!({ stopReason: 'end_turn', text: '', tools: [{ status: 'failed' }] }),
      ).toMatchObject({ accepted: false })
    })
    it('accepts a completed tool result without a final answer', () => {
      expect(
        adapter.acceptResult!({
          stopReason: 'end_turn',
          text: '',
          tools: [{ status: 'completed' }],
        }),
      ).toEqual({ accepted: true })
    })
    it('accepts a visible answer without tools', () => {
      expect(adapter.acceptResult!({ stopReason: 'end_turn', text: 'OK', tools: [] })).toEqual({
        accepted: true,
      })
    })
  })
}
