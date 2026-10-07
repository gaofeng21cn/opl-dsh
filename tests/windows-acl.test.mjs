import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertRepairTarget, buildRepairArgs } from '../installer/skill/windows-acl.mjs'

test('ACL repair validates an absolute directory and builds a non-shell argv', () => {
  const cwd = assertRepairTarget('C:/src/opl-dsh', {
    platform: 'win32',
    stat: () => ({ isDirectory: () => true }),
  })
  assert.deepEqual(buildRepairArgs(cwd, 'MECHREVO\\root'), [
    'C:/src/opl-dsh',
    '/grant',
    'MECHREVO\\root:(OI)(CI)F',
    '/C',
    '/Q',
  ])
})

test('ACL repair refuses relative paths and non-Windows hosts', () => {
  assert.throws(() => assertRepairTarget('project', { platform: 'win32' }), /绝对路径/)
  assert.throws(() => assertRepairTarget('/tmp/project', { platform: 'linux' }), /only on Windows/)
})
