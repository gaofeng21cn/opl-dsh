import { expect, it } from 'vitest'
import { nativeFailureMessage } from '../../src/execution/host/native-failure.ts'

it.each([
  ['INVALID_CREDENTIAL', '认证'],
  ['SERVER', '服务端错误'],
  ['RATE_LIMIT', '限流'],
  ['TRANSPORT', '中断'],
  ['STREAM_CLOSED', '中断'],
  [undefined, '执行失败'],
])('provides a fixed native failure diagnostic for %s', (code, expected) => {
  expect(nativeFailureMessage(code)).toContain(expected)
})

it('does not reflect unknown upstream error codes', () => {
  expect(nativeFailureMessage('synthetic-private-key')).not.toContain('synthetic-private-key')
})
