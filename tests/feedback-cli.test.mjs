/** Exercise notification receipt commands through the shipped CLI and HTTP bridge. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, cp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'opl-feedback-cli-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const requests = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const part of req) body += part
    const request = JSON.parse(body)
    requests.push(request)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true, value: { request: request.args.request } }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  await mkdir(join(root, 'profiles/desktop'), { recursive: true })
  await writeFile(
    join(root, 'profiles/desktop/control.json'),
    JSON.stringify({
      pid: process.pid,
      endpoint: `http://127.0.0.1:${server.address().port}`,
      token: 'test-only',
    }),
  )
  await cp(new URL('../installer/skill/control.mjs', import.meta.url), join(root, 'control.mjs'))
  await cp(
    new URL('../installer/windows-lifecycle.mjs', import.meta.url),
    join(root, 'windows-lifecycle.mjs'),
  )
  await writeFile(join(root, 'config.json'), JSON.stringify({ home: root, autoStart: false }))
  const run = (args, thread = 'test-reviewer') =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(root, 'control.mjs'), ...args], {
        env: { ...process.env, CODEX_THREAD_ID: thread },
      })
      let stdout = '',
        stderr = ''
      child.stdout.on('data', (part) => (stdout += part))
      child.stderr.on('data', (part) => (stderr += part))
      child.on('error', reject)
      child.on('close', (code) => resolve({ code, stdout, stderr }))
    })
  return { root, requests, run }
}

test('notification receipt syntax preserves task, delivery, owner and claim generation', async (t) => {
  const { requests, run } = await fixture(t)
  const taskId = 'task#op:initial',
    deliveryId = `${taskId}@completed`
  assert.equal((await run(['receive', taskId, deliveryId, '--consumer', 'reviewer'])).code, 0)
  assert.equal(
    (await run(['consume', taskId, deliveryId, '--epoch', '7', '--consumer', 'reviewer'])).code,
    0,
  )
  assert.equal((await run(['resume-failed', taskId, deliveryId, '--consumer', 'reviewer'])).code, 0)
  assert.deepEqual(
    requests.map((r) => [r.namespace, r.method, r.args.request]),
    [
      ['taskFeedback', 'receive', { taskId, deliveryId, consumerId: 'reviewer' }],
      ['taskFeedback', 'consume', { taskId, deliveryId, consumerId: 'reviewer', claimEpoch: 7 }],
      ['taskFeedback', 'resumeFailed', { taskId, deliveryId, consumerId: 'reviewer' }],
    ],
  )
})

test('request-file remains compatible and ambiguous or invalid receipt flags never reach the bridge', async (t) => {
  const { root, requests, run } = await fixture(t)
  const request = { taskId: 'task', deliveryId: 'delivery', consumerId: 'owner', claimEpoch: 2 }
  const file = join(root, 'receipt.json')
  await writeFile(file, JSON.stringify(request))
  assert.equal((await run(['consume', '--request-file', file])).code, 0)
  assert.deepEqual(requests[0].args.request, request)
  for (const args of [
    ['consume', 'task', 'delivery', '--epoch', 'NaN'],
    ['consume', 'task', 'delivery', '--epoch', '0'],
    ['consume', 'task', 'delivery', '--epoch', '1.5'],
    ['receive', 'task', 'delivery', '--consumre', 'owner'],
    ['receive', '--request-file', file, '--consumer', 'other'],
    ['consume', 'task', 'delivery', '--epoch', '1', '--epoch', '2'],
  ])
    assert.notEqual((await run(args)).code, 0, args.join(' '))
  assert.equal(requests.length, 1)
})

test('origin-dependent commands refuse missing or placeholder Codex identity before any RPC', async (t) => {
  const { requests, run } = await fixture(t)
  for (const command of [
    'dispatch',
    'delegate',
    'delegate-start',
    'delegate-prompt',
    'delegate-review',
    'delegate-tasks',
  ]) {
    for (const thread of ['', 'manual']) {
      const result = await run([command], thread)
      assert.notEqual(result.code, 0)
      assert.match(result.stderr, /CODEX_THREAD_ID/)
    }
  }
  assert.equal(requests.length, 0)
})
