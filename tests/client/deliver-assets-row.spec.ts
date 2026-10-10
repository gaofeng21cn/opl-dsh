import './dom.ts'
import { createTestDom } from './dom.ts'
import { afterEach, expect, it, vi } from 'vitest'
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { DeliverAssetsRow } from '../../src/execution/client/DeliverAssetsRow.tsx'
import type { DeliverAssetFile } from '../../src/execution/client/deliver-assets-markup.ts'

type ShimNode = {
  nodeType: number
  childNodes?: ShimNode[]
  parentNode?: ShimNode | null
  tagName?: string
  nodeName?: string
  textContent?: string | null
  getAttribute?(name: string): string | null
  click?(): boolean
}

/**
 * Give the shim a real bubbling `click`, so React's delegated listener runs the
 * component's own handler instead of the test reaching into it.
 */
function enableClick(dom: { document: { createElement(name: string): object } }) {
  const proto = Object.getPrototypeOf(dom.document.createElement('div')) as Record<string, unknown>
  const listeners = new WeakMap<object, Map<string, Set<(event: unknown) => void>>>()
  proto['addEventListener'] = function (type: string, listener: (event: unknown) => void) {
    let byType = listeners.get(this as object)
    if (!byType) listeners.set(this as object, (byType = new Map()))
    const set = byType.get(type) ?? new Set()
    set.add(listener)
    byType.set(type, set)
  }
  proto['removeEventListener'] = function (type: string, listener: (event: unknown) => void) {
    listeners
      .get(this as object)
      ?.get(type)
      ?.delete(listener)
  }
  const dispatch = (type: string, target: object) => {
    const event = {
      type,
      target,
      bubbles: true,
      cancelable: true,
      defaultPrevented: false,
      timeStamp: 0,
      eventPhase: 2,
      preventDefault() {
        event.defaultPrevented = true
      },
      stopPropagation() {
        stopped = true
      },
      stopImmediatePropagation() {
        stopped = true
      },
    }
    let stopped = false
    let node = target as { parentNode?: ShimNode | null } | null
    while (node) {
      for (const listener of listeners.get(node)?.get(type) ?? []) listener(event)
      node = node.parentNode
      if (stopped) break
    }
    return true
  }
  proto['dispatchEvent'] = function (type: string) {
    return dispatch(type, this)
  }
  proto['click'] = function () {
    return dispatch('click', this)
  }
}

const dom = createTestDom()
enableClick(dom)
let root: ReturnType<typeof createRoot>
afterEach(async () => {
  await React.act(async () => root?.unmount())
})

function walk(node: ShimNode, visit: (node: ShimNode) => void) {
  visit(node)
  for (const child of node.childNodes ?? []) walk(child, visit)
}
const buttonsOf = (scope: ShimNode) => {
  const found: ShimNode[] = []
  walk(scope, (node) => {
    if (node.nodeName === 'BUTTON') found.push(node)
  })
  return found
}

async function render(files: DeliverAssetFile[], openFile: (path: string) => void) {
  const container = dom.document.createElement('div')
  dom.document.body.appendChild(container)
  root = createRoot(container as unknown as HTMLElement)
  await React.act(async () =>
    root.render(
      React.createElement(DeliverAssetsRow, { node: { data: { files } }, openFile } as any),
    ),
  )
  return container as unknown as ShimNode
}

const winFile: DeliverAssetFile = {
  path: 'C:/Users/root/My Reports/年度报告 2026.md',
  name: '年度报告 2026',
}

it('shows the delivered name and the exact recorded path', async () => {
  const container = await render([winFile], () => {})
  expect(container.textContent).toContain('年度报告 2026')
  expect(container.textContent).toContain('C:/Users/root/My Reports/年度报告 2026.md')
})

it('opens the absolute path through the official owner callback, spaces and CJK intact', async () => {
  const openFile = vi.fn()
  const container = await render([winFile], openFile)
  const [button] = buttonsOf(container)
  expect(button).toBeDefined()
  await React.act(async () => button!.click!())
  expect(openFile).toHaveBeenCalledExactlyOnceWith('C:/Users/root/My Reports/年度报告 2026.md')
})

it('passes an absolute POSIX path through unchanged', async () => {
  const openFile = vi.fn()
  const container = await render([{ path: '/home/root/out/report.md', name: 'report' }], openFile)
  await React.act(async () => buttonsOf(container)[0]!.click!())
  expect(openFile).toHaveBeenCalledExactlyOnceWith('/home/root/out/report.md')
})

it('surfaces a failed open instead of swallowing it or claiming success', async () => {
  const openFile = vi.fn(() => {
    throw new Error('文件已被移动')
  })
  const container = await render([winFile], openFile)
  await React.act(async () => buttonsOf(container)[0]!.click!())
  expect(openFile).toHaveBeenCalledTimes(1)
  expect(container.textContent).toContain('打开失败')
  expect(container.textContent).toContain('文件已被移动')
  // The delivery itself is untouched: name and path remain readable.
  expect(container.textContent).toContain(winFile.path)
})

it('claims no success after a click, so a missing file is never shown as present', async () => {
  const openFile = vi.fn()
  const container = await render([winFile], openFile)
  await React.act(async () => buttonsOf(container)[0]!.click!())
  expect(container.textContent).not.toContain('已打开')
  expect(container.textContent).not.toContain('打开失败')
  expect(container.textContent).toContain(winFile.path)
})

it('renders one button per delivery', async () => {
  const container = await render(
    [winFile, { path: 'C:/out/b.md', name: 'b' }, { path: 'C:/out/c.md', name: 'c' }],
    () => {},
  )
  expect(buttonsOf(container)).toHaveLength(3)
})

it('retires a stale failure when a repeated click no longer throws', async () => {
  let fail = true
  const openFile = vi.fn(() => {
    if (fail) throw new Error('文件已被移动')
  })
  const container = await render([winFile], openFile)

  await React.act(async () => buttonsOf(container)[0]!.click!())
  expect(container.textContent).toContain('打开失败')

  // The same button keeps working; each click reaches the official opener.
  fail = false
  await React.act(async () => buttonsOf(container)[0]!.click!())
  expect(openFile).toHaveBeenCalledTimes(2)
  expect(container.textContent).not.toContain('打开失败')
  // Recovery clears the stale error only; it never becomes a success claim.
  expect(container.textContent).not.toContain('已打开')
  expect(container.textContent).toContain(winFile.path)
})

it('updates the reason when a repeated click fails again', async () => {
  let reason = '文件已被移动'
  const openFile = vi.fn(() => {
    throw new Error(reason)
  })
  const container = await render([winFile], openFile)
  await React.act(async () => buttonsOf(container)[0]!.click!())
  expect(container.textContent).toContain('文件已被移动')
  reason = '权限不足'
  await React.act(async () => buttonsOf(container)[0]!.click!())
  expect(openFile).toHaveBeenCalledTimes(2)
  expect(container.textContent).toContain('权限不足')
  expect(container.textContent).not.toContain('文件已被移动')
})

it('keeps one file failure from disturbing another delivery', async () => {
  const other: DeliverAssetFile = { path: '/home/root/b.md', name: 'b' }
  const openFile = vi.fn((path: string) => {
    if (path === winFile.path) throw new Error('文件已被移动')
  })
  const container = await render([winFile, other], openFile)
  await React.act(async () => buttonsOf(container)[0]!.click!())
  const text = container.textContent ?? ''
  // Exactly one failure surfaces, and the other delivery is untouched.
  expect(text.split('打开失败')).toHaveLength(2)
  expect(text).toContain(other.path)
})
