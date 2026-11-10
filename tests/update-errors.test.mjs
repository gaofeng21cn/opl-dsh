import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkRelease } from '../installer/update-discovery.mjs'
import { describeUpdateFailure, updateFailureError } from '../installer/update-errors.mjs'

const current = {
  suiteVersion: '0.2.58',
  officialVersion: '0.2.2-rc.1',
  platform: 'win32',
  arch: 'x64',
}

test('classifies allow-listed system and DOM error identities without reading message text', () => {
  assert.deepEqual(
    describeUpdateFailure(
      Object.assign(new Error('ordinary text mentioning proxy'), { code: 'ECONNRESET' }),
      'download',
    ),
    { stage: 'download', reason: 'network', systemCode: 'ECONNRESET' },
  )
  assert.deepEqual(
    describeUpdateFailure(
      Object.assign(new Error('unrelated'), { code: 'ERR_PROXY_AUTH_REQUIRED' }),
      'download',
    ),
    { stage: 'download', reason: 'proxy', systemCode: 'ERR_PROXY_AUTH_REQUIRED' },
  )
  assert.deepEqual(
    describeUpdateFailure({ name: 'TimeoutError', message: 'unrelated' }, 'discovery'),
    { stage: 'discovery', reason: 'timeout' },
  )
  assert.deepEqual(
    describeUpdateFailure({ name: 'NetworkError', message: 'unrelated' }, 'discovery'),
    { stage: 'discovery', reason: 'network' },
  )
  assert.deepEqual(
    describeUpdateFailure({ name: 'ProxyError', message: 'unrelated' }, 'discovery'),
    { stage: 'discovery', reason: 'proxy' },
  )
  assert.deepEqual(
    describeUpdateFailure({ name: 'UND_ERR_CONNECT_TIMEOUT', message: 'unrelated' }, 'discovery'),
    { stage: 'discovery', reason: 'timeout', systemCode: 'UND_ERR_CONNECT_TIMEOUT' },
  )
  assert.deepEqual(
    describeUpdateFailure({ name: 'AbortError', message: 'proxy connection failed' }, 'discovery'),
    { stage: 'discovery', reason: 'unknown' },
  )
  assert.deepEqual(
    describeUpdateFailure(
      Object.assign(new Error('certificate'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }),
      'download',
    ),
    { stage: 'download', reason: 'network', systemCode: 'ERR_TLS_CERT_ALTNAME_INVALID' },
  )
})

test('walks a bounded cause chain and ignores unapproved diagnostic fields', () => {
  const root = Object.assign(new Error('outer'), {
    cause: Object.assign(new Error('inner'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
    updateFailure: {
      stage: 'evil',
      reason: 'network',
      httpStatus: 999,
      systemCode: 'SECRET_CODE',
      message: 'do not persist this',
    },
  })
  assert.deepEqual(describeUpdateFailure(root, 'download'), {
    stage: 'download',
    reason: 'timeout',
    systemCode: 'UND_ERR_CONNECT_TIMEOUT',
  })

  const existing = Object.assign(new Error('existing'), {
    updateFailure: {
      stage: 'verify',
      reason: 'http',
      httpStatus: 404,
      systemCode: 'ECONNRESET',
      extra: 'ignored',
    },
  })
  assert.deepEqual(describeUpdateFailure(existing, 'download'), {
    stage: 'verify',
    reason: 'http',
    httpStatus: 404,
    systemCode: 'ECONNRESET',
  })
})

test('wraps failures while retaining message, name and cause', () => {
  const cause = Object.assign(new Error('socket reset'), { code: 'ECONNRESET' })
  cause.name = 'SystemError'
  const wrapped = updateFailureError(cause, 'download')
  assert.equal(wrapped.message, cause.message)
  assert.equal(wrapped.name, cause.name)
  assert.equal(wrapped.cause, cause)
  assert.deepEqual(wrapped.updateFailure, {
    stage: 'download',
    reason: 'network',
    systemCode: 'ECONNRESET',
  })
  assert.deepEqual(
    updateFailureError(new Error('bad archive'), 'verify', 'integrity').updateFailure,
    {
      stage: 'verify',
      reason: 'integrity',
    },
  )
})

test('discovery annotates HTTP and timeout failures without changing fetch routing', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('no', { status: 503 }))
  await assert.rejects(checkRelease(current), (error) => {
    assert.equal(error.message, '发布下载失败 HTTP 503')
    assert.deepEqual(error.updateFailure, {
      stage: 'discovery',
      reason: 'http',
      httpStatus: 503,
    })
    return true
  })

  t.mock.method(globalThis, 'fetch', async () => {
    throw Object.assign(new Error('connection failed'), { code: 'ECONNREFUSED' })
  })
  await assert.rejects(checkRelease(current), (error) => {
    assert.deepEqual(error.updateFailure, {
      stage: 'discovery',
      reason: 'network',
      systemCode: 'ECONNREFUSED',
    })
    return true
  })
})

test('discovery annotates bounded or digest-invalid responses as integrity failures', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array(1024 * 1024 + 1)))
  await assert.rejects(checkRelease(current), (error) => {
    assert.deepEqual(error.updateFailure, {
      stage: 'discovery',
      reason: 'integrity',
    })
    return true
  })
})

test('discovery annotates malformed stable metadata as an integrity failure', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{'))
  await assert.rejects(checkRelease(current), (error) => {
    assert.deepEqual(error.updateFailure, {
      stage: 'verify',
      reason: 'integrity',
    })
    return true
  })
})
