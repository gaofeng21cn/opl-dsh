import { useEffect, useRef, useState } from 'react'
import { modelRefKey } from '../contracts/catalog.ts'
import type {
  ExecutionCatalog,
  CombinationDefinition,
  HarnessCatalog,
  HarnessProxy,
} from '../../contracts/types.ts'
import type { ExecutionCall } from '../../shared/client/remote-call.ts'
/** One external Harness's proxy row, as the settings page edits it. */
export type ProxyMode = 'inherit' | 'direct' | 'custom'
export interface ProxyDraft {
  mode: ProxyMode
  url: string
}
/** What the last save attempt on one row did, so the row never claims more than it knows. */
export interface ProxyOutcome {
  id: string
  ok: boolean
  message: string
}
/** An edited row is either persistable, or refused with a message that quotes no address. */
export type ProxyValue = { ok: true; value: HarnessProxy } | { ok: false; error: string }
/**
 * The catalog is one document, so a save is all-or-nothing. `blocked` is kept apart
 * from `failed`: a save that never ran because another one was in flight must not
 * be reported as the user having changed their settings.
 */
export type SaveResult =
  | { status: 'saved'; catalog: ExecutionCatalog }
  | { status: 'failed'; message: string }
  | { status: 'blocked' }
export const PROXY_EXAMPLE = 'http://127.0.0.1:7897'
/** A missing proxy inherits the Desktop environment, exactly as the contract says. */
export function normalizeProxy(proxy: HarnessProxy | undefined): ProxyDraft {
  if (proxy?.mode === 'direct') return { mode: 'direct', url: '' }
  if (proxy?.mode === 'custom') return { mode: 'custom', url: proxy.url }
  return { mode: 'inherit', url: '' }
}
/**
 * Turn one edited row into the value to persist.
 *
 * Only a credential-free http/https URL is accepted. A proxy carrying a username or
 * password would be written into the catalog file and exported into the CLI's
 * environment, so it is refused here instead. Every message names what is wrong and
 * never quotes the address back, because a pasted proxy is itself something the user
 * may not want on screen.
 */
export function proxyFromDraft(draft: ProxyDraft): ProxyValue {
  if (draft.mode !== 'custom') return { ok: true, value: { mode: draft.mode } }
  const url = draft.url.trim()
  if (!url) return { ok: false, error: `请填写代理地址，示例 ${PROXY_EXAMPLE}` }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, error: `代理地址格式无效，示例 ${PROXY_EXAMPLE}` }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    return { ok: false, error: '仅支持 http:// 或 https:// 代理地址' }
  if (parsed.username || parsed.password)
    return { ok: false, error: '代理地址不能包含用户名或密码' }
  if (!parsed.hostname) return { ok: false, error: '代理地址缺少主机名' }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash || url.length > 2048)
    return { ok: false, error: '代理地址只接受主机和端口，不包含路径、查询或片段' }
  return { ok: true, value: { mode: 'custom', url: parsed.origin } }
}
/** A live hint for a half-typed address; silence until the user has actually typed. */
export function proxyDraftError(draft: ProxyDraft): string {
  if (draft.mode !== 'custom' || !draft.url.trim()) return ''
  const parsed = proxyFromDraft(draft)
  return parsed.ok ? '' : parsed.error
}
/** Mask any userinfo before an error reaches the page: a Host message may quote a URL. */
const URL_USERINFO = /(?:\b[a-z][a-z0-9+.-]*:)?\/\/[^/\s@]*@/gi
export function safeFailureMessage(cause: unknown, fallback = '保存失败'): string {
  const raw = cause instanceof Error && cause.message.trim() ? cause.message : fallback
  return raw.replace(URL_USERINFO, (userinfo) => userinfo.replace(/[^@]*@/, '***@')).slice(0, 300)
}
export function useExecutionCatalog(call: ExecutionCall) {
  const [catalog, setCatalog] = useState<ExecutionCatalog>()
  const [availability, setAvailability] = useState<HarnessCatalog['combinations']>([])
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('')
  const [loadRevision, setLoadRevision] = useState(0)
  const [draft, setDraft] = useState({ name: '', model: '', harness: 'dsh' })
  const [editing, setEditing] = useState<string>()
  const [proxyDrafts, setProxyDrafts] = useState<Record<string, ProxyDraft>>({}),
    [proxyErrors, setProxyErrors] = useState<Record<string, string>>({})
  const [proxyOutcome, setProxyOutcome] = useState<ProxyOutcome>()
  const running = useRef(false),
    mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    let cancelled = false
    void (async () => {
      for (let attempt = 0; attempt < 3 && !cancelled; attempt++) {
        try {
          const [next, combinations] = await Promise.all([call('catalog'), call('combinations')])
          if (!cancelled) {
            setCatalog(next)
            setAvailability(combinations)
            setNotice('')
          }
          return
        } catch {
          if (attempt === 2) {
            if (!cancelled) setNotice('无法读取组合目录')
          } else {
            await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
          }
        }
      }
    })()
    return () => {
      cancelled = true
      mounted.current = false
    }
  }, [call, loadRevision])
  const persist = async (operation: () => Promise<ExecutionCatalog>): Promise<SaveResult> => {
    if (running.current) {
      if (mounted.current) setNotice('另一个配置正在保存，请稍后再试。')
      return { status: 'blocked' }
    }
    running.current = true
    setBusy(true)
    setNotice('')
    try {
      const saved = await operation()
      if (mounted.current) setCatalog(saved)
      try {
        const combinations = await call('combinations')
        if (mounted.current) {
          setAvailability(combinations)
          setNotice('已保存，新的选择使用此配置。')
        }
      } catch {
        if (mounted.current) setNotice('配置已保存；可用状态未刷新，请重新打开此页。')
      }
      return { status: 'saved', catalog: saved }
    } catch (cause) {
      const message = safeFailureMessage(cause)
      if (mounted.current) setNotice(message)
      return { status: 'failed', message }
    } finally {
      running.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const save = (next: ExecutionCatalog) => persist(() => call('save-catalog', { catalog: next }))
  const update = (id: string, patch: Partial<CombinationDefinition>) => {
    if (!catalog) return
    const target = catalog.combinations.find((item) => item.id === id)
    if (!target) return
    void save({
      ...catalog,
      combinations: catalog.combinations.map((item) =>
        item.id === id
          ? { ...item, ...patch, generated: false }
          : patch.isDefault && modelRefKey(item.modelRef) === modelRefKey(target.modelRef)
            ? { ...item, isDefault: false }
            : item,
      ),
    })
  }
  const add = async () => {
    if (!catalog) return
    const model = catalog.models.find((item) => modelRefKey(item.ref) === draft.model)
    if (!model) return
    const result = await save({
      ...catalog,
      combinations: [
        ...catalog.combinations,
        {
          id: crypto.randomUUID(),
          name: draft.name.trim(),
          modelRef: model.ref,
          harnessRef: draft.harness,
          permissionPolicy: 'read-only',
          isDefault: false,
          enabled: true,
        },
      ],
    })
    if (result.status === 'saved' && mounted.current)
      setDraft({ name: '', model: '', harness: 'dsh' })
  }
  /**
   * Seed one row per Harness from what is stored, and only where nothing is drafted
   * yet: a reload must show the saved value without discarding edits in progress, and
   * saving one row must never redraw another row's draft over what the user typed.
   */
  useEffect(() => {
    if (!catalog) return
    setProxyDrafts((current) => {
      const next = { ...current }
      let seeded = false
      for (const harness of catalog.harnesses) {
        if (next[harness.id]) continue
        next[harness.id] = normalizeProxy(harness.proxy)
        seeded = true
      }
      return seeded ? next : current
    })
  }, [catalog])
  const editProxy = (id: string, patch: Partial<ProxyDraft>) => {
    setProxyDrafts((current) => ({
      ...current,
      [id]: { ...normalizeProxy(undefined), ...current[id], ...patch },
    }))
    // A stale refusal must not sit under a row that has been edited since.
    setProxyErrors((current) => (current[id] ? { ...current, [id]: '' } : current))
    setProxyOutcome((current) => (current?.id === id ? undefined : current))
  }
  /**
   * Persist exactly one row's proxy.
   *
   * The Host merges this proxy against its current catalog. `override`
   * carries the address still sitting in the box, because the draft write that goes
   * with it has not landed in state yet at this point in the click. A refused address
   * stops here without a write; a failed write leaves the draft alone so the user can
   * retry instead of retyping.
   */
  const saveProxy = async (id: string, override?: Partial<ProxyDraft>) => {
    if (!catalog) return false
    const draft = { ...(proxyDrafts[id] ?? normalizeProxy(undefined)), ...override }
    const parsed = proxyFromDraft(draft)
    if (!parsed.ok) {
      if (mounted.current) {
        setProxyErrors((current) => ({ ...current, [id]: parsed.error }))
        setProxyOutcome({ id, ok: false, message: parsed.error })
      }
      return false
    }
    setProxyErrors((current) => ({ ...current, [id]: '' }))
    const result = await persist(() =>
      call('save-harness-proxy', { harnessId: id, proxy: parsed.value }),
    )
    if (!mounted.current) return false
    if (result.status === 'saved') {
      // Echo back what was stored, not what was asked for: the Host owns this file.
      const stored = result.catalog.harnesses.find((harness) => harness.id === id)
      setProxyDrafts((current) => ({ ...current, [id]: normalizeProxy(stored?.proxy) }))
      setProxyOutcome({
        id,
        ok: true,
        message: '已保存。正在运行的任务保持当前连接，后续轮次重连时使用此设置。',
      })
      return true
    }
    setProxyOutcome({
      id,
      ok: false,
      message:
        result.status === 'blocked'
          ? '另一个配置正在保存，请稍后再试。'
          : `保存失败：${result.message}`,
    })
    return false
  }
  /** Drop this row's draft and show the stored value again; nothing is persisted. */
  const resetProxy = (id: string) => {
    const stored = catalog?.harnesses.find((harness) => harness.id === id)
    setProxyDrafts((current) => ({ ...current, [id]: normalizeProxy(stored?.proxy) }))
    setProxyErrors((current) => ({ ...current, [id]: '' }))
    setProxyOutcome((current) => (current?.id === id ? undefined : current))
  }
  return {
    catalog,
    availability,
    busy,
    notice,
    retry: () => {
      setNotice('')
      setLoadRevision((value) => value + 1)
    },
    draft,
    setDraft,
    editing,
    setEditing,
    update,
    add,
    proxyDrafts,
    proxyErrors,
    proxyOutcome,
    editProxy,
    saveProxy,
    resetProxy,
  }
}
