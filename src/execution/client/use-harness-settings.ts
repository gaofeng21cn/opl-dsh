import { useCallback, useEffect, useRef, useState } from 'react'
import type { HarnessInstallation } from '../../contracts/types.ts'
import type { ExecutionCall } from '../../shared/client/remote-call.ts'
import {
  normalizeProxy,
  proxyFromDraft,
  safeFailureMessage,
  type ProxyDraft,
  type ProxyOutcome,
} from './proxy-draft.ts'
/** Detection, maintenance polling and catalog edits share one busy/error owner. */
export function useHarnessSettings(call: ExecutionCall) {
  const [draft, setDraft] = useState({ name: '', command: '' })
  const [items, setItems] = useState<HarnessInstallation[]>([])
  const [proxyDrafts, setProxyDrafts] = useState<Record<string, ProxyDraft>>({})
  const [proxyErrors, setProxyErrors] = useState<Record<string, string>>({})
  const [proxyOutcome, setProxyOutcome] = useState<ProxyOutcome>()
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(true)
  const running = useRef(false),
    mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const refresh = useCallback(async () => {
    const result = await call('harness-installations')
    if (mounted.current) setItems(result)
  }, [call])
  const act = useCallback(async (operation: () => Promise<unknown>) => {
    if (running.current) return false
    running.current = true
    setBusy(true)
    setError('')
    try {
      await operation()
      return true
    } catch (cause) {
      if (mounted.current) setError(safeFailureMessage(cause, '操作未完成，请重试'))
      return false
    } finally {
      running.current = false
      if (mounted.current) setBusy(false)
    }
  }, [])
  const load = useCallback(() => act(refresh), [act, refresh])
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    if (!items.some((item) => item.maintenance?.state === 'running')) return
    const timer = setTimeout(() => {
      void load()
    }, 3000)
    return () => clearTimeout(timer)
  }, [items, load])
  const update = (id: string) =>
    act(async () => {
      await call('harness-update', { id })
      await refresh()
    })
  const savePath = (id: string, command: string) =>
    act(async () => {
      const catalog = await call('catalog')
      await call('save-catalog', {
        catalog: {
          ...catalog,
          harnesses: catalog.harnesses.map((item) =>
            item.id === id ? { ...item, command } : item,
          ),
        },
      })
      await refresh()
    })
  const register = async () => {
    let saved = false
    await act(async () => {
      const catalog = await call('catalog')
      await call('save-catalog', {
        catalog: {
          ...catalog,
          harnesses: [
            ...catalog.harnesses,
            {
              id: 'custom-' + crypto.randomUUID(),
              name: draft.name.trim(),
              kind: 'acp',
              command: draft.command.trim(),
            },
          ],
        },
      })
      saved = true
      await refresh().catch(() => {
        throw new Error('Harness 已登记；检测状态未刷新，请重新检测。')
      })
    })
    if (saved && mounted.current) setDraft({ name: '', command: '' })
  }
  useEffect(() => {
    setProxyDrafts((current) => {
      const next = { ...current }
      let seeded = false
      for (const item of items) {
        if (next[item.id]) continue
        next[item.id] = normalizeProxy(item.definition?.proxy)
        seeded = true
      }
      return seeded ? next : current
    })
  }, [items])
  const editProxy = (id: string, patch: Partial<ProxyDraft>) => {
    setProxyDrafts((current) => ({
      ...current,
      [id]: { ...normalizeProxy(undefined), ...current[id], ...patch },
    }))
    setProxyErrors((current) => (current[id] ? { ...current, [id]: '' } : current))
    setProxyOutcome((current) => (current?.id === id ? undefined : current))
  }
  const saveProxy = async (id: string, override?: Partial<ProxyDraft>) => {
    if (running.current) {
      setProxyOutcome({ id, ok: false, message: '另一个配置正在保存，请稍后再试。' })
      return false
    }
    const parsed = proxyFromDraft({
      ...(proxyDrafts[id] ?? normalizeProxy(undefined)),
      ...override,
    })
    if (!parsed.ok) {
      setProxyErrors((current) => ({ ...current, [id]: parsed.error }))
      setProxyOutcome({ id, ok: false, message: parsed.error })
      return false
    }
    setProxyErrors((current) => ({ ...current, [id]: '' }))
    let message = ''
    const saved = await act(async () => {
      try {
        const catalog = await call('save-harness-proxy', { harnessId: id, proxy: parsed.value })
        if (mounted.current) {
          setItems((current) =>
            current.map((item) => {
              const definition = catalog.harnesses.find((harness) => harness.id === item.id)
              return definition ? { ...item, definition } : item
            }),
          )
          const stored = catalog.harnesses.find((harness) => harness.id === id)
          setProxyDrafts((current) => ({ ...current, [id]: normalizeProxy(stored?.proxy) }))
        }
      } catch (cause) {
        message = safeFailureMessage(cause)
        throw new Error(message)
      }
    })
    if (!mounted.current) return false
    setProxyOutcome({
      id,
      ok: saved,
      message: saved
        ? '已保存。正在运行的任务保持当前连接，后续轮次重连时使用此设置。'
        : `保存失败：${message}`,
    })
    return saved
  }
  const resetProxy = (id: string) => {
    const stored = items.find((item) => item.id === id)?.definition
    setProxyDrafts((current) => ({ ...current, [id]: normalizeProxy(stored?.proxy) }))
    setProxyErrors((current) => ({ ...current, [id]: '' }))
    setProxyOutcome((current) => (current?.id === id ? undefined : current))
  }
  return {
    draft,
    setDraft,
    items,
    busy,
    error,
    load,
    update,
    savePath,
    register,
    proxyDrafts,
    proxyErrors,
    proxyOutcome,
    editProxy,
    saveProxy,
    resetProxy,
  }
}
