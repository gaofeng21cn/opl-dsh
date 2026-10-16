import { expect, it } from 'vitest'
import { RpcTurnOutcome } from '../../src/execution/host/adapters/rpc-turn-outcome.ts'

it('classifies an explicit client restriction without retaining provider text', () => {
  const outcome = new RpcTurnOutcome()
  outcome.accept({
    type: 'auto_retry_end',
    success: false,
    finalError: "OpenCode's free tier can only be used from within OpenCode. private-test-key",
  })
  expect(outcome.failure).toBe('HARNESS_PROVIDER_CLIENT_REQUIRED')
  expect(JSON.stringify(outcome)).not.toContain('private-test-key')
})

it('retains failure after partial text and waits through intermediate agent_end', () => {
  const outcome = new RpcTurnOutcome()
  outcome.accept({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'OK' },
  })
  outcome.accept({
    type: 'message_end',
    message: {
      role: 'assistant',
      stopReason: 'error',
      errorMessage: '429 daily quota exceeded; private-test-key',
    },
  })
  outcome.accept({ type: 'agent_end', willRetry: true })
  expect(outcome.failure).toBe('HARNESS_PROVIDER_RATE_LIMIT')
  expect(JSON.stringify(outcome)).not.toContain('private-test-key')
})

it('clears an earlier error when the official retry succeeds', () => {
  const outcome = new RpcTurnOutcome()
  outcome.accept({
    type: 'message_end',
    message: { role: 'assistant', stopReason: 'error', errorMessage: 'provider error' },
  })
  outcome.accept({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } })
  outcome.accept({ type: 'auto_retry_end', success: true })
  expect(outcome.failure).toBeUndefined()
})

it('keeps a failed retry and isolates the next turn', () => {
  const outcome = new RpcTurnOutcome()
  outcome.accept({ type: 'auto_retry_end', success: false, finalError: 'unknown provider details' })
  expect(outcome.failure).toBe('HARNESS_PROVIDER')
  outcome.reset()
  expect(outcome.failure).toBeUndefined()
  outcome.accept({
    type: 'auto_retry_end',
    success: false,
    finalError: 'maximum context length exceeded',
  })
  expect(outcome.failure).toBe('HARNESS_PROVIDER')
})
