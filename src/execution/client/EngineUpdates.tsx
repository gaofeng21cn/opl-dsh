import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ExecutionCall } from '../../shared/client/remote-call.ts'
import type { EngineUpdateState } from '../contracts/engine-updates.ts'
import css from '../../shared/client/SettingsSection.module.css'
import { safeFailureMessage } from './proxy-draft.ts'

const labels = {
  current: '已是当前版本',
  unsupported: '单独管理',
  failed: '未完成',
  installing: '正在安装',
  waiting: '等待引擎空闲',
  updated: '已更新',
  available: '可更新',
}

export function EngineUpdates({
  call,
  detectButton,
}: {
  call: ExecutionCall
  detectButton: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<EngineUpdateState>()
  const [skipped, setSkipped] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const revision = useRef(0)
  const pending = useRef(false)
  const active =
    state?.checking || state?.items.some((item) => ['installing', 'waiting'].includes(item.status))
  useEffect(() => {
    let mounted = true
    const read = async () => {
      if (pending.current) return
      const id = ++revision.current
      try {
        const s = await call('engine-updates')
        if (mounted && id === revision.current) {
          setState(s)
        }
      } catch (e) {
        if (mounted && id === revision.current)
          setError(safeFailureMessage(e, '无法读取引擎更新状态'))
      }
    }
    void read()
    const timer = setInterval(() => void read(), active ? 2000 : 30000)
    return () => {
      mounted = false
      clearInterval(timer)
    }
  }, [active, call])
  const run = async (fn: () => Promise<EngineUpdateState>) => {
    if (pending.current) return
    pending.current = true
    const id = ++revision.current
    setBusy(true)
    setError('')
    try {
      const s = await fn()
      if (id === revision.current) setState(s)
    } catch (e) {
      setError(safeFailureMessage(e, '操作未完成，请重试'))
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const batchIds = new Set(state?.selectedIds)
  const batch = state?.items.filter((item) => batchIds.has(item.id)) ?? []
  const finished = batch.filter((item) => item.status === 'updated' || item.status === 'failed')
  const available =
    state?.items.filter((item) => item.status === 'available' && !batchIds.has(item.id)) ?? []
  const selected = available.filter((item) => !skipped.includes(item.id)).map((item) => item.id)
  const others =
    state?.items.filter((item) => item.status !== 'available' && !batchIds.has(item.id)) ?? []
  return (
    <>
      <div className={`${css.actions} ${css.engineUpdateToolbar}`}>
        {detectButton}
        <Button
          id="opl-engine-updates-toggle"
          variant="outline"
          aria-expanded={open}
          aria-controls="opl-engine-updates"
          onClick={() => setOpen(!open)}
        >
          管理更新{available.length > 0 && `（${available.length}）`}
        </Button>
      </div>
      {open && (
        <section
          id="opl-engine-updates"
          className={`${css.section} ${css.engineUpdatePanel}`}
          aria-label="执行引擎更新"
        >
          <div className={css.preferenceRow}>
            <span className={css.preferenceTitle}>自动检查执行引擎更新</span>
            <Switch
              label="自动检查执行引擎更新"
              disabled={!state || busy}
              checked={state?.enabled ?? false}
              onChange={(enabled) => {
                if (state)
                  void run(() => call('engine-updates-settings', { enabled, mode: state.mode }))
              }}
            />
          </div>
          {state?.enabled && (
            <label className={css.field}>
              发现更新后
              <select
                className={css.input}
                disabled={busy}
                value={state.mode}
                onChange={(e) => {
                  const mode = e.currentTarget.value === 'auto' ? 'auto' : 'notify'
                  void run(() => call('engine-updates-settings', { enabled: true, mode }))
                }}
              >
                <option value="notify">仅提醒</option>
                <option value="auto">自动安装更新</option>
              </select>
            </label>
          )}
          {state?.enabled && state.mode === 'auto' && (
            <p className={css.muted}>正在使用的执行引擎将在空闲后更新。</p>
          )}
          {available.map((item) => (
            <label className={css.row} key={item.id}>
              <input
                type="checkbox"
                disabled={busy}
                checked={selected.includes(item.id)}
                onChange={(e) =>
                  setSkipped(
                    e.currentTarget.checked
                      ? skipped.filter((id) => id !== item.id)
                      : [...skipped, item.id],
                  )
                }
              />
              <span className={css.engineUpdateName}>{item.name}</span>
              <span className={css.muted}>
                {item.current} → {item.target}
              </span>
            </label>
          ))}
          <div className={`${css.actions} ${css.engineUpdateToolbar}`}>
            <Button
              variant="outline"
              disabled={busy || active}
              onClick={() => void run(() => call('engine-updates-check'))}
            >
              {state?.checking ? '正在检查…' : '检查引擎更新'}
            </Button>
            {available.length > 0 && (
              <Button
                disabled={busy || !selected.length || state?.checking}
                onClick={() => {
                  setSubmitting(true)
                  void run(() => call('engine-updates-install', { ids: selected })).finally(() =>
                    setSubmitting(false),
                  )
                }}
              >
                {submitting ? '正在提交更新…' : `更新所选（${selected.length}）`}
              </Button>
            )}
          </div>
          {batch.length > 0 && (
            <div aria-live="polite" className={css.engineBatch}>
              <p>
                本次更新 · 已处理 {finished.length}/{batch.length}
              </p>
              {batch.map((item) => (
                <div key={item.id}>
                  <p className={css.row}>
                    <span>{item.name}</span>
                    <span className={item.status === 'failed' ? css.error : css.muted}>
                      {item.status === 'available' ? '排队中' : labels[item.status]}
                    </span>
                  </p>
                  {item.status === 'failed' && item.message && (
                    <p className={css.error}>{item.message}</p>
                  )}
                </div>
              ))}
            </div>
          )}
          {state?.checkedAt && (
            <p className={css.muted}>上次检查：{new Date(state.checkedAt).toLocaleString()}</p>
          )}
          {others.length > 0 && (
            <details className={css.engineCheckResults}>
              <summary>其他检查结果（{others.length}）</summary>
              {others.map((item) => (
                <p key={item.id}>
                  {item.name} · {labels[item.status]}
                  {item.message && <span className={css.muted}> · {item.message}</span>}
                </p>
              ))}
            </details>
          )}
          {error && (
            <p className={css.error} role="alert">
              {error}
            </p>
          )}
        </section>
      )}
    </>
  )
}
