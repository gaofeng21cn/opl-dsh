import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { harnessProxyEnvironment, normalizeHarnessProxy } from '../../src/execution/host/proxy.ts'
import {
  ExecutionCatalogStore,
  defaultExecutionCatalog,
  normalizeCatalog,
} from '../../src/execution/host/catalog.ts'

it('persists independent routing and preserves the CLI entry and combinations across reload', async () => {
  const home = await mkdtemp(join(tmpdir(), 'opl-proxy-catalog-'))
  try {
    const store = new ExecutionCatalogStore(home)
    const catalog = await store.get()
    catalog.harnesses.find((h) => h.id === 'minimax-code')!.proxy = {
      mode: 'custom',
      url: 'http://127.0.0.1:7897/',
    }
    catalog.harnesses.find((h) => h.id === 'claude')!.proxy = { mode: 'direct' }
    const saved = await store.set(catalog)
    const loaded = await new ExecutionCatalogStore(home).get()
    expect(loaded).toEqual(saved)
    expect(loaded.harnesses.find((h) => h.id === 'minimax-code')).toMatchObject({
      command: 'mcode',
      proxy: { mode: 'custom', url: 'http://127.0.0.1:7897' },
    })
    expect(loaded.harnesses.find((h) => h.id === 'codex')!.proxy).toBeUndefined()
    expect(loaded.combinations).toEqual(catalog.combinations)
    const bytes = await readFile(store.filename, 'utf8')
    const invalid = {
      ...catalog,
      harnesses: catalog.harnesses.map((h) =>
        h.id === 'minimax-code'
          ? { ...h, proxy: { mode: 'custom', url: 'http://user:secret@host:3128' } }
          : h,
      ),
    }
    await expect(store.set(invalid)).rejects.toThrow('不含账号密码')
    expect(await readFile(store.filename, 'utf8')).toBe(bytes)
    expect(await store.get()).toEqual(saved)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

it.each([
  'socks5://localhost:1080',
  'http://user:secret@host',
  'https://host/a',
  'http://host?secret=x',
  'http://host/#token',
  'not-a-url',
  'http://host:99999',
])('rejects unusable proxy input without reflecting it: %s', (url) => {
  try {
    normalizeHarnessProxy({ mode: 'custom', url })
    throw Error('accepted invalid proxy')
  } catch (error) {
    expect((error as Error).message).toBe('代理地址须为不含账号密码的 HTTP 或 HTTPS 地址')
  }
})

it('serializes independent proxy saves without losing another Harness or newer CLI settings', async () => {
  const home = await mkdtemp(join(tmpdir(), 'opl-proxy-merge-'))
  try {
    const store = new ExecutionCatalogStore(home)
    const catalog = await store.get()
    catalog.harnesses.find((h) => h.id === 'minimax-code')!.command = 'C:/custom mcode/mcode.cmd'
    const commandSave = store.set(catalog)
    const proxyA = store.setProxy('minimax-code', { mode: 'custom', url: 'http://localhost:7897' })
    const proxyB = store.setProxy('grok-build', { mode: 'direct' })
    await Promise.all([commandSave, proxyA, proxyB])
    const saved = await store.get()
    expect(saved.harnesses.find((h) => h.id === 'minimax-code')).toMatchObject({
      command: 'C:/custom mcode/mcode.cmd',
      proxy: { mode: 'custom', url: 'http://localhost:7897' },
    })
    expect(saved.harnesses.find((h) => h.id === 'grok-build')!.proxy).toEqual({ mode: 'direct' })
    await expect(store.setProxy('missing', { mode: 'direct' })).rejects.toThrow('不存在')
    await expect(store.setProxy('dsh', { mode: 'direct' })).rejects.toThrow('内置 DSH')
    expect(await store.get()).toEqual(saved)
    await store.setProxy('grok-build', { mode: 'inherit' })
    expect((await store.get()).harnesses.find((h) => h.id === 'minimax-code')!.proxy).toEqual({
      mode: 'custom',
      url: 'http://localhost:7897',
    })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

it('rejects unsupported routing for the same-process DSH provider', () => {
  const catalog = defaultExecutionCatalog()
  catalog.harnesses[0]!.proxy = { mode: 'direct' }
  expect(() => normalizeCatalog(catalog)).toThrow('内置 DSH')
  catalog.harnesses[0]!.proxy = { mode: 'inherit' }
  expect(normalizeCatalog(catalog).harnesses[0]!.proxy).toEqual({ mode: 'inherit' })
})

it('custom routing replaces mixed-case inherited proxies while keeping local bridges direct', () => {
  const environment = {
    HTTP_PROXY: 'http://old',
    https_proxy: 'http://other',
    All_PrOxY: 'socks5://old',
    No_Proxy: '*',
    PATH: 'original-path',
    MCODE_SHELL_PATH: 'git-bash',
  }
  const next = harnessProxyEnvironment(environment, {
    mode: 'custom',
    url: 'http://127.0.0.1:7897',
  })
  expect(next).toEqual({
    HTTP_PROXY: 'http://127.0.0.1:7897',
    HTTPS_PROXY: 'http://127.0.0.1:7897',
    NO_PROXY: 'localhost,127.0.0.1,::1',
    PATH: 'original-path',
    MCODE_SHELL_PATH: 'git-bash',
  })
  expect(environment.All_PrOxY).toBe('socks5://old')
  expect(harnessProxyEnvironment(environment, { mode: 'direct' })).toEqual({
    PATH: 'original-path',
    MCODE_SHELL_PATH: 'git-bash',
  })
  expect(harnessProxyEnvironment(environment, { mode: 'inherit' })).toEqual(environment)
  expect(harnessProxyEnvironment(environment, undefined)).toEqual(environment)
})
