import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  desktopUpdateEndpoint,
  requestDesktopUpdate,
  serveDesktopUpdate,
} from '../installer/desktop-update.mjs'

test('uses a short Unix socket path and serves the owned update channel', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'opl-desktop-update-'))
  const application = join(root, 'DeepSeek Harness.app')
  const serverIdentity = {
    profileHome: join(root, 'profile'),
    application,
    suiteSha256: 'a'.repeat(64),
  }
  const endpoint = desktopUpdateEndpoint({
    platform: 'darwin',
    pid: 12345,
    nonce: '01234567-89ab-cdef-0123-456789abcdef',
  })
  assert.ok(endpoint.startsWith('/tmp/'))
  assert.ok(endpoint.length < 104)

  const control = await serveDesktopUpdate(root, serverIdentity, async (request) => ({
    method: request.method,
  }))
  t.after(async () => {
    await control.close()
    await rm(root, { recursive: true, force: true })
  })

  assert.ok(control.record.endpoint.length < 104)
  assert.deepEqual(
    await requestDesktopUpdate(root, { ...serverIdentity, app: application }, 'inspect'),
    { method: 'inspect' },
  )
})
