import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { HarnessSession } from '../../../src/execution/contracts/sessions.ts'
import type { AdapterOptions } from '../../../src/execution/host/adapters/types.ts'
import { ExternalModelSources } from '../../../src/execution/host/model-sources.ts'
import {
  zcodeOfmAdapter,
  zcodeOfmBridgePath,
} from '../../../src/execution/host/adapters/zcode-ofm/zcode-ofm.ts'
import {
  assertOfmModelSelection,
  OFM_ZCODE_PROVIDER_ID,
} from '../../../src/execution/host/adapters/zcode-ofm/zcode-ofm-models.ts'

const gate = vi.hoisted(() => ({
  wait: undefined as Promise<void> | undefined,
  entered: undefined as (() => void) | undefined,
}))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return {
    ...actual,
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      const result = await actual.mkdir(...args)
      if (gate.wait) {
        const wait = gate.wait
        gate.wait = undefined
        gate.entered?.()
        await wait
      }
      return result
    },
  }
})
vi.mock('node:child_process', () => ({
  // This test controls shell qualification; no child receives the adapter environment.
  execFile: Object.assign(() => {}, {
    [Symbol.for('nodejs.util.promisify.custom')]: async () => ({
      stdout: 'OPL_GIT_BASH:MINGW64_NT-10.0\n',
      stderr: '',
    }),
  }),
}))

const roots: string[] = []
afterEach(async () => {
  gate.wait = undefined
  gate.entered = undefined
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('resolves the emitted bridge beside the shipped index.js bundle', () => {
  expect(zcodeOfmBridgePath('file:///C:/owned/package/lib/index.js')).toMatch(
    /zcode-ofm-bridge\.mjs$/,
  )
})

it('refuses a current snapshot without the selected reasoning value', () => {
  expect(() =>
    assertOfmModelSelection(
      {
        settings: {
          model: { current: { providerId: OFM_ZCODE_PROVIDER_ID, modelId: 'z-ai/glm-5.3' } },
        },
      },
      'z-ai/glm-5.3',
      'enabled',
    ),
  ).toThrow()
})

it('refuses source disposal during profile preparation after route resolution', async () => {
  const ctx = { effect: (fn: () => unknown) => fn() } as unknown as Context
  const sources = new ExternalModelSources(ctx)
  const off = sources.register(ctx, {
    provider: 'our-free-model',
    supports: () => true,
    resolve: async () => ({
      model: 'z-ai/glm-5.3',
      baseURL: 'http://127.0.0.1:41000/v1',
      apiKey: 'controlled-test-key',
      protocol: 'chat' as const,
    }),
  })
  const home = await mkdtemp(join(tmpdir(), 'zcode-chief-'))
  roots.push(home)
  let release!: () => void
  const entered = new Promise<void>((resolve) => {
    gate.entered = resolve
  })
  gate.wait = new Promise<void>((resolve) => {
    release = resolve
  })
  const record = {
    id: 'chief-owned',
    harnessRef: 'zcode',
    modelRef: { provider: 'our-free-model', model: 'z-ai/glm-5.3' },
    cwd: home,
    sandbox: 'full-access',
  } as HarnessSession
  const options = { home, command: process.execPath, modelSources: sources } as AdapterOptions
  const preparation = zcodeOfmAdapter.prepare!(ctx, record, options)
  const rejected = preparation.then(
    () => false,
    () => true,
  )
  await entered
  off()
  release()
  expect(await rejected).toBe(true)
})
