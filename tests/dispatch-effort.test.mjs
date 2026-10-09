import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, cp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'

async function fixture(t, { refuseEffort = false, failRegistrationOnce = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'opl-effort-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const selections = []
  let prompts = 0
  let registrations = 0
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const part of req) body += part
    const { method, args } = JSON.parse(body)
    const input = args.request
    let value = {}
    if (method === 'create') value = { sessionId: input.sessionId }
    if (method === 'selectModel') {
      selections.push(input.reasoningEffort)
      value = { selected: { ...input, ...(refuseEffort ? { reasoningEffort: 'high' } : {}) } }
    }
    if (method === 'register') {
      registrations++
      if (failRegistrationOnce && registrations === 1) {
        res.end(JSON.stringify({ ok: false, error: 'test registration disconnected' }))
        return
      }
      value = { task: input }
    }
    if (method === 'prompt') {
      prompts++
      value = { accepted: true }
    }
    res.end(JSON.stringify({ ok: true, value }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  await mkdir(join(root, 'profiles/desktop'), { recursive: true })
  await writeFile(
    join(root, 'profiles/desktop/control.json'),
    JSON.stringify({
      pid: process.pid,
      endpoint: `http://127.0.0.1:${server.address().port}`,
      token: 'fixture-only',
    }),
  )
  await cp(new URL('../installer/skill/control.mjs', import.meta.url), join(root, 'control.mjs'))
  await cp(
    new URL('../installer/windows-lifecycle.mjs', import.meta.url),
    join(root, 'windows-lifecycle.mjs'),
  )
  const config = (effort) =>
    writeFile(
      join(root, 'config.json'),
      JSON.stringify({
        home: root,
        ledger: join(root, 'ledger'),
        dispatchReasoningEffort: effort,
        autoStart: false,
      }),
    )
  await config('max')
  const prompt = join(root, 'prompt.txt')
  await writeFile(prompt, 'read-only test')
  const run = (operation = 'initial', explicitEffort) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          join(root, 'control.mjs'),
          'dispatch',
          '--task',
          'effort-task',
          '--operation',
          operation,
          '--cwd',
          root,
          '--prompt-file',
          prompt,
          ...(explicitEffort ? ['--reasoning-effort', explicitEffort] : []),
        ],
        { env: { ...process.env, CODEX_THREAD_ID: 'effort-test-thread' } },
      )
      let stdout = '',
        stderr = ''
      child.stdout.on('data', (data) => {
        stdout += data
      })
      child.stderr.on('data', (data) => {
        stderr += data
      })
      child.once('error', reject)
      child.once('exit', (code) => resolve({ code, stdout, stderr }))
    })
  return { run, config, selections, counts: () => ({ prompts, registrations }) }
}

test('dispatch preserves its first resolved max effort across a disconnected attempt and changed defaults', async (t) => {
  const f = await fixture(t, { failRegistrationOnce: true })
  assert.notEqual((await f.run()).code, 0)
  assert.equal(f.counts().prompts, 0)
  await f.config('high')
  const recovered = await f.run()
  assert.equal(recovered.code, 0, recovered.stderr)
  assert.equal(JSON.parse(recovered.stdout).reasoningEffort, 'max')
  assert.deepEqual(f.selections, ['max', 'max'])
  assert.equal(f.counts().prompts, 1)
  assert.equal(JSON.parse((await f.run()).stdout).idempotent, true)
  assert.equal(f.counts().prompts, 1)
  const next = await f.run('next')
  assert.equal(next.code, 0, next.stderr)
  assert.equal(f.selections.at(-1), 'high')
  const explicit = await f.run('explicit', 'max')
  assert.equal(explicit.code, 0, explicit.stderr)
  assert.equal(f.selections.at(-1), 'max')
  const conflict = await f.run('explicit', 'high')
  assert.notEqual(conflict.code, 0)
  assert.match(conflict.stderr, /operation ID/)
  assert.equal(f.counts().prompts, 3)
})

test('dispatch refuses to register or send a prompt if the Host falls back from max to high', async (t) => {
  const f = await fixture(t, { refuseEffort: true })
  const result = await f.run()
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /推理档位校验失败/)
  assert.deepEqual(f.counts(), { prompts: 0, registrations: 0 })
})
