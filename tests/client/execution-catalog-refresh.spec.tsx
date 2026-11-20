import { createTestDom } from './dom.ts'
import { afterEach, expect, it, vi } from 'vitest'
import * as React from 'react'
import type { Root } from 'react-dom/client'
import { useExecutionCatalog } from '../../src/execution/client/use-execution-catalog.ts'
import type { ExecutionCatalog } from '../../src/execution/contracts/catalog.ts'
import type { ExecutionCall } from '../../src/shared/client/remote-call.ts'

const dom = createTestDom()
const { createRoot } = await import('react-dom/client')
const { act } = React
const roots: Root[] = []
afterEach(async () => {
  await act(async () => roots.splice(0).forEach((root) => root.unmount()))
  vi.restoreAllMocks()
})

const catalog = (): ExecutionCatalog => ({
  harnesses: [{ id: 'dsh', kind: 'dsh', name: 'DSH' }],
  models: [],
  combinations: [
    {
      id: 'ordinary',
      name: 'Ordinary',
      modelRef: { provider: 'opl-gateway', model: 'deepseek-flash' },
      harnessRef: 'dsh',
      permissionPolicy: 'read-only',
      isDefault: true,
      enabled: true,
    },
  ],
})

it('defers a projection refresh until an ordinary catalog save has settled', async () => {
  let served = catalog()
  const save = Promise.withResolvers<ExecutionCatalog>()
  const catalogReads = vi.fn(async () => served)
  const call = vi.fn(async (method: string, input?: { catalog: ExecutionCatalog }) => {
    if (method === 'catalog') return catalogReads()
    if (method === 'combinations') return []
    if (method === 'save-catalog') {
      served = input!.catalog
      return save.promise
    }
    throw new Error('unexpected RPC ' + method)
  }) as unknown as ExecutionCall
  let api: ReturnType<typeof useExecutionCatalog> | undefined
  function Probe({ refreshKey }: { refreshKey: boolean }) {
    api = useExecutionCatalog(call, refreshKey)
    return null
  }
  const root = createRoot(dom.container() as unknown as Element)
  roots.push(root)
  await act(async () => root.render(React.createElement(Probe, { refreshKey: false })))
  expect(catalogReads).toHaveBeenCalledTimes(1)

  await act(async () => {
    api!.update('ordinary', { name: 'Edited ordinary' })
  })
  await act(async () => root.render(React.createElement(Probe, { refreshKey: true })))
  expect(catalogReads).toHaveBeenCalledTimes(1)

  await act(async () => {
    save.resolve(served)
  })
  await vi.waitFor(() => expect(catalogReads).toHaveBeenCalledTimes(2))
  expect(served.combinations[0]?.name).toBe('Edited ordinary')
})
