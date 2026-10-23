import { expect, it } from 'vitest'
import { openCodeStreamFailure } from '../../src/execution/host/adapters/opencode/stream-failure.ts'
const line =
  'timestamp=now level=ERROR run=one message="stream error" providerID=opencode modelID=beam-free session.id=ses_owned small=false agent=build mode=primary error.error="AI_APICallError: Free usage limit reached. secret-value"'
it('classifies quota failure without exposing raw diagnostics', () => {
  expect(openCodeStreamFailure(line, 'ses_owned')).toContain('额度已达上限')
  expect(openCodeStreamFailure(line, 'ses_owned')).not.toContain('secret-value')
})
it('ignores title failures, other sessions and ordinary output', () => {
  expect(
    openCodeStreamFailure(line.replace('small=false', 'small=true'), 'ses_owned'),
  ).toBeUndefined()
  expect(openCodeStreamFailure(line, 'ses_other')).toBeUndefined()
  expect(
    openCodeStreamFailure(line.replace('level=ERROR', 'level=INFO'), 'ses_owned'),
  ).toBeUndefined()
  expect(openCodeStreamFailure('Free usage limit reached.', 'ses_owned')).toBeUndefined()
})
it('reports a primary API error without inventing its HTTP status', () => {
  const result = openCodeStreamFailure(
    line.replace('Free usage limit reached.', 'unknown provider failure'),
    'ses_owned',
  )
  expect(result).toContain('未取得可确认的 HTTP 状态')
})
