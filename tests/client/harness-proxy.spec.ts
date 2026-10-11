/**
 * Per-Harness network proxy in 设置 → 运行配置.
 *
 * These tests drive the real `ExecutionCatalogSection` — the settings surface the user
 * actually opens — through the same minimal DOM as the sibling client specs, and only
 * through public behaviour: choosing a mode, typing an address, pressing 保存代理,
 * and the OPL RPC calls that result. Nothing asserts on hook internals, and no
 * implementation is mirrored here.
 *
 * They pin the product decisions that matter to a user:
 *  - every external Harness (Codex CLI, Claude Code, Grok Build, MiniMax, any other
 *    registered CLI) gets its own 继承环境 / 直连 / 指定代理 choice, saved only when
 *    that row's own button is pressed, and one row's save never edits another's;
 *  - the built-in DSH Harness runs in the desktop process, so its row cannot be set
 *    and says so;
 *  - only a credential-free http/https address is accepted, and a refused address is
 *    reported without quoting the address back;
 *  - a failed or out-of-order save says so instead of claiming the settings changed.
 */
import { createTestDom } from './dom.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import type { ReactNode } from 'react'
import type { ExecutionCall } from '../../src/shared/client/remote-call.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  // The published primitives package is not loadable from this offline install, so the
  // two atoms this section uses are stood in for. Both pass their props straight
  // through, which is what the desktop composition relies on anyway.
  Button: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) =>
    React.createElement('button', { ...props, type: 'button' }, children),
  Switch: ({ label, ...props }: { label?: string } & Record<string, unknown>) =>
    React.createElement('button', { ...props, role: 'switch' }, label),
}))

// `./dom.ts` installs the process DOM on import, before React DOM is loaded.
const dom = createTestDom()
const { act } = React
const { ExecutionCatalogSection } = await import(
  '../../src/execution/client/ExecutionCatalogSection.tsx'
)
const { createRoot } = await import('react-dom/client')

type Node = {
  nodeName: string
  textContent: string | null
  childNodes: Node[]
  parentNode: Node | null
  value: string
  checked: boolean
  click: () => boolean
  dispatchEvent: (type: string) => boolean
  getAttribute: (name: string) => string | null
}

/**
 * Give the shared DOM shim the three things this section needs and the shim does not
 * model. Only elements created by the process DOM are touched, and no component or
 * production code changes.
 *
 *  - bubbling listeners, so a click reaches React's delegated root handler;
 *  - `input.type` reflecting its attribute, which React reads to decide whether an
 *    element is a radio;
 *  - the `value` property jsdom gives elements, so a typed address can be read back.
 *
 * There is deliberately no `checked` property: React installs its own tracker for one,
 * and supplying a second breaks the radio path it drives.
 */
function completeDom() {
  const proto = Object.getPrototypeOf(dom.document.createElement('div')) as Record<string, unknown>
  const listeners = new WeakMap<object, Map<string, Set<(event: unknown) => void>>>()
  proto['addEventListener'] = function (type: string, listener: (event: unknown) => void) {
    let byType = listeners.get(this as object)
    if (!byType) listeners.set(this as object, (byType = new Map()))
    const set = byType.get(type) ?? new Set()
    set.add(listener)
    byType.set(type, set)
  }
  const dispatch = function (type: string, target: object): boolean {
    const event = {
      type,
      target,
      bubbles: true,
      cancelable: true,
      defaultPrevented: false,
      timeStamp: 0,
      eventPhase: 2,
      preventDefault() {},
      stopPropagation() {},
      stopImmediatePropagation() {},
    }
    let node = target as { parentNode: object | null } | null
    while (node) {
      for (const listener of [...(listeners.get(node)?.get(type) ?? [])]) listener(event)
      node = node.parentNode
    }
    return true
  }
  proto['dispatchEvent'] = function (type: string) {
    return dispatch(type, this)
  }
  proto['click'] = function () {
    return dispatch('click', this)
  }
  Object.defineProperty(proto, 'type', {
    get(this: Node) {
      return this.getAttribute('type') ?? ''
    },
    configurable: true,
  })
  const values = new WeakMap<object, string>()
  Object.defineProperty(proto, 'value', {
    get(this: object) {
      return values.get(this) ?? ''
    },
    set(this: object, next: unknown) {
      values.set(this, String(next))
    },
    configurable: true,
  })
  // `select.options` is the collection React walks when a select takes a value.
  Object.defineProperty(proto, 'options', {
    get(this: Node) {
      const found: Node[] = []
      const visit = (node: Node) => {
        for (const child of node.childNodes ?? []) {
          if (child.nodeName === 'OPTION') found.push(child)
          visit(child)
        }
      }
      visit(this)
      return found
    },
    configurable: true,
  })
}
completeDom()

function walk(node: unknown, into: Node[] = []): Node[] {
  const element = node as Node
  into.push(element)
  for (const child of element.childNodes ?? []) walk(child, into)
  return into
}
/** The one control carrying `attribute="id"` inside `scope`. */
function control(scope: unknown, attribute: string, id: string): Node {
  const found = walk(scope).find((node) => node.getAttribute?.(attribute) === id)
  expect(found, `找不到 ${attribute}=${id}`).toBeDefined()
  return found!
}
/** The row rendering one Harness's proxy choices. */
const row = (container: unknown, id: string) => control(container, 'data-opl-proxy-row', id)
/** The three mode radios, in the order the section offers them. */
const modeRadios = (scope: Node) =>
  walk(scope).filter((node) => node.nodeName === 'INPUT' && node.getAttribute('type') === 'radio')
const text = (scope: unknown) => (scope as Node).textContent ?? ''

/** Choose 继承环境 / 直连 / 指定代理 by the label the user reads. */
async function chooseMode(scope: Node, label: string) {
  const radio = modeRadios(scope).find((item) => item.value === modeOf(label))
  expect(radio, `找不到代理方式「${label}」`).toBeDefined()
  await act(async () => {
    radio!.checked = true
    radio!.dispatchEvent('click')
  })
}
const modeOf = (label: string) =>
  ({ 继承环境: 'inherit', 直连: 'direct', 指定代理: 'custom' })[label] ?? label

async function typeAddress(scope: Node, id: string, address: string) {
  const input = control(scope, 'data-opl-proxy-url', id)
  await act(async () => {
    input.value = address
  })
}
async function press(node: Node) {
  await act(async () => {
    node.click()
  })
}
const saveButton = (scope: Node, id: string) => control(scope, 'data-opl-proxy-save', id)
const addressOf = (scope: Node, id: string) => control(scope, 'data-opl-proxy-url', id).value

type Harness = { id: string; name: string; kind: string; command?: string; proxy?: unknown }
/** The catalogue as the Host projects it: a built-in DSH plus the registered external CLIs. */
function catalog(proxies: Record<string, unknown> = {}) {
  return {
    version: 2,
    models: [
      {
        ref: { provider: 'minimax-official', model: 'MiniMax-M3.1-Flash-Preview' },
        name: 'MiniMax-M3.1-Flash-Preview',
        source: 'MiniMax 官方账号（mcode）',
        available: true,
      },
    ],
    harnesses: [
      { id: 'dsh', name: 'DSH', kind: 'dsh', adapter: 'native-session' },
      { id: 'codex', name: 'Codex CLI', kind: 'acp', command: 'codex' },
      { id: 'claude', name: 'Claude Code', kind: 'acp', command: 'claude' },
      { id: 'grok-build', name: 'Grok Build', kind: 'grok-build', adapter: 'acp-v1' },
      { id: 'minimax-code', name: 'MiniMax Code', kind: 'acp', command: 'mcode' },
      { id: 'custom-cli', name: '自建 CLI', kind: 'acp', command: 'my-cli --serve' },
    ].map((harness) => ({
      ...harness,
      ...(harness.id in proxies ? { proxy: proxies[harness.id] } : {}),
    })),
    combinations: [
      {
        id: 'codex/one',
        name: 'Codex 组合',
        modelRef: { provider: 'minimax-official', model: 'MiniMax-M3.1-Flash-Preview' },
        harnessRef: 'codex',
        permissionPolicy: 'full-access',
        isDefault: true,
        enabled: true,
      },
    ],
  }
}
type Calls = { method: string; args: unknown }[]
/** RPC stub over a catalog the stub itself owns, so re-opening reads back what was saved. */
function fixture(start: ReturnType<typeof catalog>, save?: (next: any) => unknown) {
  const calls: Calls = []
  // The wire carries JSON, so the stub round-trips exactly like the real transport.
  let stored = JSON.parse(JSON.stringify(start))
  const call = (async (method: string, args?: unknown) => {
    calls.push({ method, args })
    if (method === 'catalog') return JSON.parse(JSON.stringify(stored))
    if (method === 'combinations')
      return stored.combinations.map((item: { id: string }) => ({ id: item.id, available: true }))
    if (method === 'save-harness-proxy') {
      const request = args as { harnessId: string; proxy: unknown }
      const next = {
        ...stored,
        harnesses: stored.harnesses.map((h: Harness) =>
          h.id === request.harnessId ? { ...h, proxy: request.proxy } : h,
        ),
      }
      const verdict = save?.(next)
      if (verdict instanceof Error) throw verdict
      if (verdict instanceof Promise) await verdict
      stored = JSON.parse(JSON.stringify(next))
      return JSON.parse(JSON.stringify(stored))
    }
    throw new Error(`unexpected RPC ${method}`)
  }) as unknown as ExecutionCall
  const saves = () => calls.filter((entry) => entry.method === 'save-harness-proxy')
  const saved = () => ({ catalog: stored as ReturnType<typeof catalog> })
  const harnessOf = (sent: { harnesses: Harness[] }, id: string): Harness =>
    sent.harnesses.find((item) => item.id === id)!
  return { call, calls, saves, saved, harnessOf, stored: () => stored }
}
/** The stored catalog, read back over the same RPC the settings page uses. */
const readCatalog = (call: ExecutionCall) => call('catalog') as Promise<ReturnType<typeof catalog>>

const mounted: Array<() => Promise<void>> = []
afterEach(async () => {
  while (mounted.length) await mounted.pop()!()
})
/** Open 设置 → 运行配置 the way the desktop does and let the catalog load. */
async function open(call: ExecutionCall) {
  const container = dom.container()
  const root = createRoot(container as unknown as Element)
  mounted.push(() =>
    act(async () => {
      root.unmount()
    }),
  )
  await act(async () => {
    root.render(React.createElement(ExecutionCatalogSection as never, { call }))
  })
  return container
}

describe('每个外部 Harness 独立的代理设置', () => {
  it('为每个外部 Harness 提供三种方式，内置 DSH 不可设置并说明原因', async () => {
    const { call } = fixture(catalog())
    const view = await open(call)

    for (const id of ['codex', 'claude', 'grok-build', 'minimax-code', 'custom-cli']) {
      const radios = modeRadios(row(view, id))
      expect(
        radios.map((radio) => radio.value),
        `${id} 未提供三种代理方式`,
      ).toEqual(['inherit', 'direct', 'custom'])
      expect(text(row(view, id))).toContain(
        id === 'codex'
          ? 'Codex CLI'
          : id === 'claude'
            ? 'Claude Code'
            : id === 'grok-build'
              ? 'Grok Build'
              : id === 'minimax-code'
                ? 'MiniMax Code'
                : '自建 CLI',
      )
      // Every external row can be saved on its own.
      expect(saveButton(row(view, id), id).getAttribute('aria-label')).toContain('保存')
      // Nothing is chosen for the user, and no address is asked for yet.
      expect(radios.filter((radio) => radio.checked)).toHaveLength(1)
      expect(radios.find((radio) => radio.checked)!.value).toBe('inherit')
      expect(
        walk(row(view, id)).filter((n) => n.getAttribute?.('data-opl-proxy-url')),
      ).toHaveLength(0)
    }

    // The built-in DSH Harness is in-process and says so rather than silently vanishing.
    const dsh = row(view, 'dsh')
    expect(text(dsh)).toContain('DSH')
    expect(text(dsh)).toContain('内置 DSH 与桌面同进程运行')
    expect(text(dsh)).toContain('不经过这个子进程代理选项')
    for (const radio of modeRadios(dsh))
      expect(radio.getAttribute('disabled'), 'DSH 的代理方式应不可选').not.toBeNull()
    expect(walk(dsh).filter((n) => n.getAttribute?.('data-opl-proxy-save'))).toHaveLength(0)
  })

  it('只保存被编辑的那一个 Harness，其它 Harness、模型与运行配置一字不动', async () => {
    const { call, saves, saved, harnessOf } = fixture(catalog())
    const view = await open(call)
    const before = await readCatalog(call)

    await chooseMode(row(view, 'codex'), '指定代理')
    await typeAddress(row(view, 'codex'), 'codex', 'http://127.0.0.1:7897')
    await press(saveButton(row(view, 'codex'), 'codex'))

    expect(saves()).toHaveLength(1)
    expect(saves()[0]!.args).toEqual({
      harnessId: 'codex',
      proxy: { mode: 'custom', url: 'http://127.0.0.1:7897' },
    })
    const sent = saved().catalog
    expect(harnessOf(sent, 'codex').proxy).toEqual({ mode: 'custom', url: 'http://127.0.0.1:7897' })
    // Every other Harness keeps exactly what it had, command included.
    expect(sent.harnesses.filter((harness: Harness) => harness.id !== 'codex')).toEqual(
      before.harnesses.filter((harness: Harness) => harness.id !== 'codex'),
    )
    expect(sent.models).toEqual(before.models)
    expect(sent.combinations).toEqual(before.combinations)
    // And the row says what actually happened to running work.
    expect(text(control(view, 'data-opl-proxy-outcome', 'codex'))).toContain('已保存')
    expect(text(control(view, 'data-opl-proxy-outcome', 'codex'))).toContain('后续轮次重连')
  })

  it('切换到直连与继承环境各自独立保存', async () => {
    const { call, saved, harnessOf } = fixture(catalog())
    const view = await open(call)

    await chooseMode(row(view, 'grok-build'), '直连')
    await press(saveButton(row(view, 'grok-build'), 'grok-build'))
    expect(harnessOf(saved().catalog, 'grok-build').proxy).toEqual({ mode: 'direct' })

    await chooseMode(row(view, 'claude'), '指定代理')
    await typeAddress(row(view, 'claude'), 'claude', 'https://proxy.example.test:8443')
    await press(saveButton(row(view, 'claude'), 'claude'))
    expect(harnessOf(saved().catalog, 'claude').proxy).toEqual({
      mode: 'custom',
      url: 'https://proxy.example.test:8443',
    })

    // Back to inheriting the desktop environment, which is what "no proxy" means.
    await chooseMode(row(view, 'grok-build'), '继承环境')
    await press(saveButton(row(view, 'grok-build'), 'grok-build'))
    expect(harnessOf(saved().catalog, 'grok-build').proxy).toEqual({ mode: 'inherit' })
    // Claude's saved address is untouched by Grok Build's later change.
    expect(harnessOf(saved().catalog, 'claude').proxy).toEqual({
      mode: 'custom',
      url: 'https://proxy.example.test:8443',
    })
  })

  it('重新打开运行配置时回显已保存的设置', async () => {
    const { call } = fixture(catalog({ codex: { mode: 'custom', url: 'http://127.0.0.1:7897' } }))
    const view = await open(call)

    const codex = row(view, 'codex')
    expect(modeRadios(codex).find((radio) => radio.checked)!.value).toBe('custom')
    expect(addressOf(codex, 'codex')).toBe('http://127.0.0.1:7897')
    // The built-in row has no address box at all, because it cannot be set.
    expect(
      walk(row(view, 'dsh')).filter((node) => node.getAttribute?.('data-opl-proxy-url')),
    ).toHaveLength(0)
    // A stored 直连 comes back as 直连, not as the first option.
    const direct = await open(fixture(catalog({ claude: { mode: 'direct' } })).call)
    expect(modeRadios(row(direct, 'claude')).find((radio) => radio.checked)!.value).toBe('direct')
  })

  it('只接受无用户名密码的 http/https 地址，拒绝时不写入也不回显地址', async () => {
    const { call, saves } = fixture(catalog())
    const view = await open(call)

    for (const [address, expected] of [
      ['', '请填写代理地址'],
      ['not a url at all', '格式无效'],
      ['ftp://proxy.example.test:2121', '仅支持 http'],
      ['http://user:secret@proxy.example.test:7897', '不能包含用户名或密码'],
    ] as const) {
      await chooseMode(row(view, 'codex'), '指定代理')
      await typeAddress(row(view, 'codex'), 'codex', address)
      await press(saveButton(row(view, 'codex'), 'codex'))
      const shown = text(control(row(view, 'codex'), 'data-opl-proxy-error', 'codex'))
      expect(shown, `地址 ${address || '(空)'} 应被拒绝`).toContain(expected)
      if (address) expect(shown, '拒绝提示不应回显地址').not.toContain(address)
      expect(shown).not.toContain('secret')
      expect(text(row(view, 'codex')), '被拒绝的行不应显示已保存').not.toContain('已保存')
      expect(saves(), '被拒绝的地址不应写入').toHaveLength(0)
    }
  })

  it('保存失败时不谎称成功，并保留已填内容以便重试', async () => {
    let attempt = 0
    const { call, saves } = fixture(catalog(), () => {
      attempt++
      if (attempt === 1) return new Error('无法写入运行配置')
      return undefined
    })
    const view = await open(call)

    await chooseMode(row(view, 'codex'), '指定代理')
    await typeAddress(row(view, 'codex'), 'codex', 'http://127.0.0.1:7897')
    await press(saveButton(row(view, 'codex'), 'codex'))

    expect(saves()).toHaveLength(1)
    let shown = text(control(view, 'data-opl-proxy-outcome', 'codex'))
    expect(shown).toContain('保存失败')
    expect(shown).toContain('无法写入运行配置')
    expect(shown).not.toContain('已保存')
    // The typed address survives the failure, so retrying costs nothing.
    expect(addressOf(row(view, 'codex'), 'codex')).toBe('http://127.0.0.1:7897')

    await press(saveButton(row(view, 'codex'), 'codex'))
    expect(saves()).toHaveLength(2)
    shown = text(control(view, 'data-opl-proxy-outcome', 'codex'))
    expect(shown).toContain('已保存')
  })

  it('不把含凭据的地址写进错误提示', async () => {
    const { call } = fixture(
      catalog(),
      () => new Error('保存失败：无法连接 http://user:hunter2@10.0.0.1:7897'),
    )
    const view = await open(call)

    await chooseMode(row(view, 'codex'), '指定代理')
    await typeAddress(row(view, 'codex'), 'codex', 'http://127.0.0.1:7897')
    await press(saveButton(row(view, 'codex'), 'codex'))

    const shown = text(view)
    expect(shown).toContain('保存失败')
    expect(shown, '错误提示不应带出用户名密码').not.toContain('hunter2')
    expect(shown).not.toContain('user:hunter2')
  })

  it('快速连按两次保存时只写入一次，另一行如实告知未保存', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { call, saves, harnessOf } = fixture(catalog(), () => gate)
    const view = await open(call)

    await chooseMode(row(view, 'codex'), '指定代理')
    await typeAddress(row(view, 'codex'), 'codex', 'http://127.0.0.1:7897')
    await chooseMode(row(view, 'claude'), '直连')

    // Both clicks land in the same batch, which is the window a user can hit.
    await act(async () => {
      saveButton(row(view, 'codex'), 'codex').click()
      saveButton(row(view, 'claude'), 'claude').click()
    })
    expect(saves(), '第二次保存不应另起一次写入').toHaveLength(1)
    expect(text(control(view, 'data-opl-proxy-outcome', 'claude'))).not.toContain('已保存')

    await act(async () => {
      release()
      await gate
    })

    // Only Codex was written; Claude's choice is still waiting for its own save.
    const sent = await readCatalog(call)
    expect(harnessOf(sent, 'codex').proxy).toEqual({ mode: 'custom', url: 'http://127.0.0.1:7897' })
    expect(harnessOf(sent, 'claude').proxy).toBeUndefined()
    expect(text(control(view, 'data-opl-proxy-outcome', 'codex'))).toContain('已保存')

    // The row that lost the race keeps its draft and can still be saved.
    await press(saveButton(row(view, 'claude'), 'claude'))
    expect(harnessOf(await readCatalog(call), 'claude').proxy).toEqual({
      mode: 'direct',
    })
  })

  it('保存一项时不影响另一项尚未保存的草稿', async () => {
    const { call } = fixture(catalog())
    const view = await open(call)

    await chooseMode(row(view, 'claude'), '指定代理')
    await typeAddress(row(view, 'claude'), 'claude', 'http://127.0.0.1:1080')
    await chooseMode(row(view, 'codex'), '直连')
    await press(saveButton(row(view, 'codex'), 'codex'))

    // The Claude draft was never saved and must survive Codex's save untouched.
    expect(modeRadios(row(view, 'claude')).find((radio) => radio.checked)!.value).toBe('custom')
    expect(addressOf(row(view, 'claude'), 'claude')).toBe('http://127.0.0.1:1080')
    expect(text(control(view, 'data-opl-proxy-outcome', 'codex'))).toContain('已保存')
  })

  it('放弃修改后回到已保存的值，且不触发写入', async () => {
    const { call, saves } = fixture(catalog({ codex: { mode: 'direct' } }))
    const view = await open(call)
    const before = saves().length

    await chooseMode(row(view, 'codex'), '指定代理')
    await typeAddress(row(view, 'codex'), 'codex', 'http://127.0.0.1:7897')
    await press(control(row(view, 'codex'), 'data-opl-proxy-reset', 'codex'))

    expect(saves()).toHaveLength(before)
    expect(modeRadios(row(view, 'codex')).find((radio) => radio.checked)!.value).toBe('direct')
  })
})
