import { expect, it } from 'vitest'
import {
  bridgeFailure,
  failureDiagnosticSuffix,
  HarnessReportedError,
  safeFailureDetails,
} from '../../src/execution/host/adapters/failure-diagnostics.ts'

it('preserves Codex structured status and category without its message or extra fields', () => {
  const error = new HarnessReportedError(
    'codex',
    {
      message: 'synthetic-private-key',
      codexErrorInfo: {
        httpConnectionFailed: { httpStatusCode: 503, body: 'synthetic-private-key' },
      },
      data: { service: 'session' },
    },
    'failed',
  )
  expect(bridgeFailure(error)).toEqual({
    code: 'HARNESS_EXECUTION',
    message: '官方 Harness 调用未完成',
    data: {
      service: 'codex',
      errorName: 'httpConnectionFailed',
      httpStatus: 503,
      terminalState: 'failed',
    },
  })
  expect(JSON.stringify(bridgeFailure(error))).not.toContain('synthetic-private')
})

it.each([null, '503', 200, 600, 500.5, { statusCode: 503 }])(
  'does not invent an HTTP error from invalid status %j or message text',
  (status) => {
    const data = {
      statusCode: status,
      message: 'HTTP 503 synthetic-private-key',
      details: '{"statusCode":503}',
      errorName: 'synthetic-private-key',
      service: 'synthetic-private-key',
    }
    expect(safeFailureDetails(data)).toEqual({})
    expect(failureDiagnosticSuffix(data)).toBe('')
  },
)

it('keeps RPC refusal distinct from an HTTP status', () => {
  const error = new HarnessReportedError('zcode', {
    code: -32602,
    message: 'synthetic-private-key',
  })
  expect(error.details).toEqual({ service: 'zcode', rpcCode: -32602 })
  expect(failureDiagnosticSuffix(error.details)).toBe('（ZCode；RPC -32602）')
})

it('does not reflect arbitrary thrown errors through the ACP bridge', () => {
  expect(bridgeFailure(new Error('synthetic-private-key'))).toEqual({
    code: 'HARNESS_UNKNOWN',
    message: '官方 Harness 调用未完成',
  })
})

it('preserves bounded ZCode provider cause facts without raw messages', () => {
  const error = new HarnessReportedError(
    'zcode',
    {
      message: 'private',
      cause: { context: { providerCode: 'NO_PROGRESS', responseStatus: 200 }, message: 'private' },
    },
    'failed',
  )
  expect(error.details.errorName).toBe('NO_PROGRESS')
  expect(error.details.httpStatus).toBeUndefined()
  expect(JSON.stringify(bridgeFailure(error))).not.toContain('private')
})

it('recognizes the flattened official ZCode no-progress diagnostic without echoing it', () => {
  const error = new HarnessReportedError(
    'zcode',
    {
      type: 'unknown_error',
      code: 'UNKNOWN_ERROR',
      attribution: { providerErrorCode: 'NO_PROGRESS', statusCode: 200 },
      underlyingErrorMessage:
        'EAC returned no text, reasoning or tool progress for 60s; the request was stopped and will not be retried automatically (phase=reading_sse, status=200, frames=0, invalidJsonFrames=0)',
    },
    'failed',
  )
  expect(error.details.errorName).toBe('NO_PROGRESS')
  expect(error.details.httpStatus).toBeUndefined()
  expect(safeFailureDetails({ underlyingErrorMessage: 'private NO_PROGRESS secret' })).toEqual({})
})
