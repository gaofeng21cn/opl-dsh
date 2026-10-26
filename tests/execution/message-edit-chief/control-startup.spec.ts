import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { beforeEach, expect, it, vi } from 'vitest'
import type { ExternalEditContext } from '../../../src/execution/host/message-edit-driver.ts'
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: mocks.spawn,
}))
import { startAuthenticatedControl } from '../../../src/execution/host/message-edit-opencode-common.ts'
let child: EventEmitter & {
  stdout: PassThrough
  stderr: PassThrough
  exitCode: number | null
  signalCode: string | null
}
const spec = {
  passwordEnv: 'OPENCODE_SERVER_PASSWORD',
  usernameEnv: 'OPENCODE_SERVER_USERNAME',
  defaultUsername: 'opencode',
}
function context(signal: AbortSignal) {
  return {
    signal,
    record: { cwd: process.cwd() },
    launch: { command: process.execPath, args: ['acp'], env: {} },
  } as unknown as ExternalEditContext
}
beforeEach(() => {
  child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
  })
  mocks.spawn.mockReturnValue(child)
})
it('cancels startup without waiting for the announcement timeout and removes listeners', async () => {
  const abort = new AbortController()
  const pending = startAuthenticatedControl(context(abort.signal), spec)
  abort.abort()
  await expect(pending).rejects.toMatchObject({ code: 'aborted' })
  expect(child.listenerCount('exit')).toBe(0)
  expect(child.listenerCount('error')).toBe(0)
  expect(child.stdout.listenerCount('data')).toBe(0)
})
it('removes startup listeners after the endpoint is announced', async () => {
  const pending = startAuthenticatedControl(context(new AbortController().signal), spec)
  child.stdout.write('server listening on http://127.0.0.1:12345\n')
  const control = await pending
  expect(child.listenerCount('exit')).toBe(0)
  expect(child.listenerCount('error')).toBe(0)
  await control.close()
})
