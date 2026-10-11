import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { generateRpc } from '../scripts/generate-rpc.mjs'

const repository = resolve(import.meta.dirname, '..')
test('generated start and delegate codecs preserve explicit MiniMax full access', async () => {
  const { TYPERT } = await import('../src/generated/host.mjs')
  const origin = { kind: 'codex', sessionId: 'minimax-rpc-review' }
  for (const method of ['start', 'delegate']) {
    const invocation = TYPERT.invocations.find(
      (item) => item.namespace === 'oplExecution' && item.method === method,
    )
    const codec = invocation.parameters.find((item) => item.wire === 'request').codec.create()
    const request = {
      combination: 'minimax-code/MiniMax-M3',
      cwd: repository,
      origin,
      taskId: 'minimax-rpc-review',
      sandbox: 'full-access',
      ...(method === 'delegate'
        ? { task: 'readonly check', operationId: 'initial', wait: false }
        : {}),
    }
    assert.equal(codec.parse(request).sandbox, 'full-access')
    assert.equal(codec.parse({ ...request, sandbox: 'workspace' }).sandbox, 'workspace')
    assert.throws(() => codec.parse({ ...request, sandbox: 'unrecognized' }))
  }
})
test('generated delegate and prompt codecs preserve operation write scopes', async () => {
  const { TYPERT } = await import('../src/generated/host.mjs')
  for (const method of ['delegate', 'prompt']) {
    const invocation = TYPERT.invocations.find(
      (item) => item.namespace === 'oplExecution' && item.method === method,
    )
    const codec = invocation.parameters.find((item) => item.wire === 'request').codec.create()
    const request =
      method === 'delegate'
        ? {
            origin: { kind: 'codex', sessionId: 'scope-review' },
            task: 'scoped work',
            taskId: 'scope-task',
            operationId: 'one',
            sandbox: 'full-access',
          }
        : { sessionId: 'harness-scope', text: 'scoped work', operationId: 'one' }
    assert.deepEqual(
      codec.parse({ ...request, writeScope: ['src/a.ts', 'tests/a.ts'] }).writeScope,
      ['src/a.ts', 'tests/a.ts'],
    )
    assert.throws(() => codec.parse({ ...request, writeScope: 'src' }))
  }
})
const source = (type = 'string') => `
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
export interface Snapshot { value: ${type} }
class ProbeService extends TypertRemoteService {
  constructor(ctx: Context) { super(ctx, 'probe') }
  @Remote
  read(): Promise<Snapshot> { return Promise.resolve({ value: ${type === 'string' ? "'ready'" : '42'} }) }
}
export const Service = ProbeService
`

test('official generator derives source contracts, rejects drift, and preserves checked files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opl-rpc-test-'))
  try {
    await mkdir(join(root, 'src'))
    await mkdir(join(root, 'installer'))
    await mkdir(join(root, 'scripts/mcode-candidate'), { recursive: true })
    await symlink(join(repository, 'node_modules'), join(root, 'node_modules'), 'junction')
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        name: '@opl/rpc-fixture',
        type: 'module',
        exports: { '.': './src/index.ts', './types': './src/index.ts' },
      }),
    )
    await writeFile(
      join(root, 'tsconfig.host.json'),
      JSON.stringify({
        ...JSON.parse(await readFile(join(repository, 'tsconfig.host.json'), 'utf8')),
        include: ['src/index.ts'],
      }),
    )
    await writeFile(join(root, 'src/index.ts'), source())
    await generateRpc({ root })
    const original = await readFile(join(root, 'src/generated/host.mjs'), 'utf8')
    assert.match(original, /probe\/read/)
    const { TYPERT } = await import(pathToFileURL(join(root, 'src/generated/host.mjs')).href)
    const invocation = TYPERT.invocations.find(
      (item) => item.namespace === 'probe' && item.method === 'read',
    )
    assert.deepEqual(invocation.result.create().parse({ value: 'ready' }), {
      value: 'ready',
    })
    assert.throws(() => invocation.result.create().parse({ value: 42 }))
    const map = JSON.parse(await readFile(join(root, 'src/generated/remote.d.mts.map'), 'utf8'))
    assert.equal(map.file, 'remote.d.mts')
    assert.deepEqual(map.sources, ['../index.ts'])
    await generateRpc({ root, check: true })
    await writeFile(join(root, 'src/index.ts'), source('number'))
    await assert.rejects(generateRpc({ root, check: true }), /RPC generation drift/)
    assert.equal(await readFile(join(root, 'src/generated/host.mjs'), 'utf8'), original)
    await generateRpc({ root })
    assert.notEqual(await readFile(join(root, 'src/generated/host.mjs'), 'utf8'), original)
    await generateRpc({ root, check: true })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
