import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  OplFlowCarrier,
  OplFlowDashboardEnvelope,
  OplFlowInboxEntry,
  OplFlowSessionEntry,
  OplFlowTabId,
} from '../contracts/index.ts'
import type { OplFlowCall } from './types.ts'
import css from './OplFlowPanel.module.css'

const TABS: readonly { id: OplFlowTabId; zh: string; en: string }[] = [
  { id: 'needs_action', zh: '需你拍板', en: 'Needs action' },
  { id: 'safe_to_archive', zh: '待批归档', en: 'Ready to archive' },
  { id: 'active_objectives', zh: '进行中', en: 'Active' },
  { id: 'active_sessions', zh: '活跃对话', en: 'Active sessions' },
  { id: 'blocked', zh: '外部阻塞', en: 'Blocked' },
  { id: 'backlog', zh: '待排期', en: 'Backlog' },
  { id: 'pending_events', zh: '待处理事件', en: 'Pending events' },
]

function carrierLabel(carrier: string | null | undefined, zh: boolean): string {
  if (carrier === 'codex') return 'Codex'
  if (carrier === 'antigravity') return 'AntiGravity'
  if (carrier === 'dsh') return 'OPL DSH'
  return zh ? '自动路由' : 'Auto'
}

export interface OplFlowPanelProps {
  call: OplFlowCall
  locale: 'zh' | 'en'
  openSession: (sessionId: string) => void
  startSession: (workspacePath?: string) => void
}

export function OplFlowPanel({ call, locale, openSession, startSession }: OplFlowPanelProps) {
  const zh = locale === 'zh'
  const [dashboard, setDashboard] = useState<OplFlowDashboardEnvelope | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [activeTab, setActiveTab] = useState<OplFlowTabId>('needs_action')
  const [confirmApproveId, setConfirmApproveId] = useState<string | null>(null)
  const [composeOpen, setComposeOpen] = useState(false)
  const [objectiveId, setObjectiveId] = useState('')
  const [title, setTitle] = useState('')
  const [message, setMessage] = useState('')
  const [executor, setExecutor] = useState<'' | OplFlowCarrier>('')
  const [executionMode, setExecutionMode] = useState<'active' | 'backlog'>('active')
  const [runNow, setRunNow] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const next = await call('dashboard')
      setDashboard(next)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [call])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const data = dashboard?.state === 'ready' ? dashboard.data : undefined
  const counts = data?.counts

  const firstNonEmptyTab = useMemo<OplFlowTabId>(() => {
    if (!counts) return 'needs_action'
    for (const tab of TABS) {
      if ((counts[tab.id] ?? 0) > 0) return tab.id
    }
    return 'needs_action'
  }, [counts])

  useEffect(() => {
    if (counts && (counts[activeTab] ?? 0) === 0 && (counts[firstNonEmptyTab] ?? 0) > 0) {
      setActiveTab(firstNonEmptyTab)
    }
  }, [counts, activeTab, firstNonEmptyTab])

  async function runAction(
    action: () => Promise<{ ok: boolean; message?: string | undefined }>,
    fallback: string,
  ) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const result = await action()
      if (!result.ok) {
        setError(result.message || fallback)
        return false
      }
      setNotice(result.message || fallback)
      await refresh()
      return true
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      return false
    } finally {
      setBusy(false)
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    const clean = message.trim()
    if (!clean) {
      setError(zh ? '请输入任务描述或拍板指令。' : 'Enter a task instruction.')
      return
    }
    const ok = await runAction(
      () =>
        call('send', {
          message: clean,
          execution_mode: executionMode,
          now: runNow,
          ...(objectiveId.trim()
            ? { objective_id: objectiveId.trim() }
            : title.trim()
              ? { title: title.trim() }
              : {}),
          ...(executor ? { executor } : {}),
        }),
      zh ? '已投递至 OPL Flow 队列。' : 'Dispatched to OPL Flow.',
    )
    if (ok) {
      setMessage('')
      setTitle('')
      setObjectiveId('')
      setComposeOpen(false)
    }
  }

  function renderObjectiveJump(entry: OplFlowInboxEntry) {
    if (entry.jump_mode === 'native_switch' && entry.session_id) {
      return (
        <Button size="sm" variant="outline" onClick={() => openSession(entry.session_id!)}>
          {zh ? '切换 DSH 会话' : 'Switch to DSH chat'}
        </Button>
      )
    }
    if (entry.jump_mode === 'external_focus_only') {
      return (
        <>
          <span className={css.badge}>
            {zh
              ? `当前由 ${carrierLabel(entry.execution_carrier, zh)} 持有`
              : `Held by ${carrierLabel(entry.execution_carrier, zh)}`}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => startSession(entry.workspace_path ?? undefined)}
          >
            {zh ? '新建 DSH 会话' : 'New DSH chat'}
          </Button>
        </>
      )
    }
    return (
      <Button
        size="sm"
        variant="outline"
        onClick={() => startSession(entry.workspace_path ?? undefined)}
      >
        {zh ? '在 DSH 新建对话' : 'Start DSH chat'}
      </Button>
    )
  }

  const serviceRunning = Boolean(data?.service?.running)
  const serviceBridge = data?.service?.bridge || 'auto'
  const occupants =
    (data?.inbox?.active_workspace_occupants?.length
      ? data.inbox.active_workspace_occupants
      : data?.active_sessions?.active_workspace_occupants) ?? []
  const activeSessions =
    (data?.inbox?.active_sessions?.length
      ? data.inbox.active_sessions
      : data?.active_sessions?.sessions) ?? []
  const pendingEvents = data?.inbox?.pending_events ?? []
  const currentEntries = (
    activeTab !== 'active_sessions' && activeTab !== 'pending_events'
      ? (data?.inbox?.[activeTab] ?? [])
      : []
  ) as OplFlowInboxEntry[]

  return (
    <section className={css.root} data-testid="opl-flow-dsh-panel">
      <header className={css.header}>
        <div>
          <div className={css.titleRow}>
            <h1>{zh ? 'OPL Flow 总控' : 'OPL Flow Control Tower'}</h1>
            {data?.instance_name ? <span className={css.badge}>{data.instance_name}</span> : null}
          </div>
          <p className={css.subtitle}>
            {zh
              ? '跨 Codex / AntiGravity / OPL DSH 的个人长期目标总账与自动路由控制塔（不自建第二套聊天框）；推进对话将直接跳转或新建 DSH 原生会话。'
              : 'Personal cross-carrier Beads/Dolt ledger and auto-router control tower. Opens or creates native DSH sessions.'}
          </p>
        </div>
        <div className={css.actions}>
          <Button size="sm" variant="outline" onClick={() => setComposeOpen((prev) => !prev)}>
            {zh ? '投递任务 / 指令' : 'Dispatch'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={loading || busy}
            onClick={() => void refresh()}
          >
            {zh ? '刷新' : 'Refresh'}
          </Button>
        </div>
      </header>

      {error ? (
        <p className={css.error} role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className={css.notice} role="status">
          {notice}
        </p>
      ) : null}

      {dashboard?.state === 'unavailable' ? (
        <div className={css.card}>
          <p className={css.notice}>
            {dashboard.reason ||
              (zh ? '本机尚未绑定 OPL Flow 实例。' : 'OPL Flow is not configured.')}
          </p>
        </div>
      ) : null}

      {data ? (
        <>
          <div className={`${css.card} ${css.routerBar}`}>
            <div className={css.actions}>
              <span className={css.badge}>
                {serviceRunning
                  ? zh
                    ? '后台路由运行中'
                    : 'Router running'
                  : zh
                    ? '后台路由已停止'
                    : 'Router stopped'}
              </span>
              <span className={css.badge}>{`bridge: ${serviceBridge}`}</span>
              {occupants.length > 0 ? (
                <span className={css.badge}>
                  {zh
                    ? `防撞车保护 ${occupants.length} 个工作区`
                    : `${occupants.length} workspace guards`}
                </span>
              ) : null}
            </div>
            <div className={css.actions}>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void runAction(
                    () =>
                      call('service', {
                        action: serviceRunning ? 'down' : 'up',
                        bridge: 'auto',
                        confirmed: true,
                      }),
                    serviceRunning
                      ? zh
                        ? '已停止后台路由。'
                        : 'Router stopped.'
                      : zh
                        ? '已启动后台路由。'
                        : 'Router started.',
                  )
                }
              >
                {serviceRunning
                  ? zh
                    ? '停止路由'
                    : 'Stop router'
                  : zh
                    ? '启动自动路由'
                    : 'Start router'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void runAction(
                    () => call('tick', { dry_run: false }),
                    zh ? '已完成一轮状态评估。' : 'Tick completed.',
                  )
                }
              >
                {zh ? '立即评估 (Tick)' : 'Tick now'}
              </Button>
            </div>
          </div>

          {composeOpen ? (
            <form className={css.card} onSubmit={(event) => void handleSubmit(event)}>
              <div className={css.formGrid}>
                <label className={css.field}>
                  <span>{zh ? '目标编号（留空则新建）' : 'Objective ID'}</span>
                  <input
                    className={css.input}
                    value={objectiveId}
                    onChange={(e) => setObjectiveId(e.target.value)}
                    placeholder="opl-123"
                  />
                </label>
                {!objectiveId.trim() ? (
                  <label className={css.field}>
                    <span>{zh ? '目标标题（可选）' : 'Title'}</span>
                    <input
                      className={css.input}
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                    />
                  </label>
                ) : null}
                <label className={css.field}>
                  <span>{zh ? '执行载体' : 'Executor'}</span>
                  <select
                    className={css.select}
                    value={executor}
                    onChange={(e) => setExecutor(e.target.value as '' | OplFlowCarrier)}
                  >
                    <option value="">{zh ? '自动路由 (auto)' : 'Auto'}</option>
                    <option value="dsh">OPL DSH</option>
                    <option value="codex">Codex</option>
                    <option value="antigravity">AntiGravity</option>
                  </select>
                </label>
                <label className={css.field}>
                  <span>{zh ? '队列模式' : 'Mode'}</span>
                  <select
                    className={css.select}
                    value={executionMode}
                    onChange={(e) => setExecutionMode(e.target.value as 'active' | 'backlog')}
                  >
                    <option value="active">{zh ? '立即排入进行中' : 'Active'}</option>
                    <option value="backlog">{zh ? '暂存待排期' : 'Backlog'}</option>
                  </select>
                </label>
              </div>
              <label className={css.field}>
                <span>{zh ? '任务内容或拍板指令' : 'Instruction'}</span>
                <textarea
                  className={css.textarea}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                />
              </label>
              <div className={css.actions}>
                <label className={css.badge}>
                  <input
                    type="checkbox"
                    checked={runNow}
                    onChange={(e) => setRunNow(e.target.checked)}
                  />
                  <span>{zh ? '投递后立即执行一轮状态评估' : 'Tick immediately'}</span>
                </label>
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  onClick={() => setComposeOpen(false)}
                >
                  {zh ? '取消' : 'Cancel'}
                </Button>
                <Button size="sm" type="submit" disabled={busy}>
                  {zh ? '确认投递' : 'Submit'}
                </Button>
              </div>
            </form>
          ) : null}

          <div
            className={css.tablist}
            role="tablist"
            aria-label={zh ? 'OPL Flow 控制塔分类' : 'Control tower sections'}
          >
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                className={css.tab}
                aria-selected={activeTab === tab.id}
                onClick={() => setActiveTab(tab.id)}
              >
                <span>{zh ? tab.zh : tab.en}</span>
                <span>{counts?.[tab.id] ?? 0}</span>
              </button>
            ))}
          </div>

          {activeTab === 'active_sessions' ? (
            <div className={css.list}>
              {activeSessions.length === 0 ? (
                <div className={css.card}>
                  <p className={css.notice}>
                    {zh ? '当前无活跃本地会话。' : 'No active sessions.'}
                  </p>
                </div>
              ) : (
                activeSessions.map((sess: OplFlowSessionEntry) => (
                  <article className={css.card} key={sess.session_ref}>
                    <div className={css.itemHead}>
                      <div className={css.itemTitle}>
                        <span className={css.badge}>{carrierLabel(sess.carrier, zh)}</span>
                        <strong>{sess.title || sess.model_label || sess.session_ref}</strong>
                        {sess.workspace_label ? (
                          <span className={css.badge}>{sess.workspace_label}</span>
                        ) : null}
                      </div>
                      <div className={css.actions}>
                        {sess.jump_mode === 'native_switch' && sess.session_id ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => openSession(sess.session_id!)}
                          >
                            {zh ? '切换 DSH 会话' : 'Switch to DSH chat'}
                          </Button>
                        ) : (
                          <>
                            <span className={css.badge}>
                              {zh
                                ? `外部载体：${carrierLabel(sess.carrier, zh)}`
                                : `External: ${carrierLabel(sess.carrier, zh)}`}
                            </span>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => startSession(sess.workspace_path ?? undefined)}
                            >
                              {zh ? '新建 DSH 会话' : 'New DSH chat'}
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                    <div
                      className={css.itemMeta}
                    >{`${sess.session_ref} · ${sess.status || 'idle'}`}</div>
                  </article>
                ))
              )}
            </div>
          ) : activeTab === 'pending_events' ? (
            <div className={css.list}>
              {pendingEvents.length === 0 ? (
                <div className={css.card}>
                  <p className={css.notice}>{zh ? '当前无待处理事件。' : 'No pending events.'}</p>
                </div>
              ) : (
                pendingEvents.map((ev) => (
                  <article className={css.card} key={ev.event_id}>
                    <div className={css.itemTitle}>
                      <span className={css.badge}>{ev.event_type}</span>
                      <strong>{ev.objective_id}</strong>
                      <span className={css.badge}>{ev.status || 'pending'}</span>
                    </div>
                    {ev.summary ? <div className={css.itemMeta}>{ev.summary}</div> : null}
                  </article>
                ))
              )}
            </div>
          ) : (
            <div className={css.list}>
              {currentEntries.length === 0 ? (
                <div className={css.card}>
                  <p className={css.notice}>{zh ? '该分类下暂无目标。' : 'No items.'}</p>
                </div>
              ) : (
                currentEntries.map((entry) => (
                  <article className={css.card} key={entry.bead_id}>
                    <div className={css.itemHead}>
                      <div className={css.itemTitle}>
                        <strong>{entry.title}</strong>
                        <span className={css.badge}>{entry.bead_id}</span>
                        {entry.execution_carrier ? (
                          <span className={css.badge}>
                            {carrierLabel(entry.execution_carrier, zh)}
                          </span>
                        ) : null}
                      </div>
                      <div className={css.actions}>
                        {renderObjectiveJump(entry)}
                        {activeTab === 'safe_to_archive' ? (
                          confirmApproveId === entry.bead_id ? (
                            <>
                              <Button
                                size="sm"
                                disabled={busy}
                                onClick={() => {
                                  setConfirmApproveId(null)
                                  void runAction(
                                    () =>
                                      call('approve', {
                                        bead_id: entry.bead_id,
                                        approved_by: 'owner',
                                        confirmed: true,
                                      }),
                                    zh
                                      ? `已批准归档 ${entry.bead_id}。`
                                      : `Approved archive for ${entry.bead_id}.`,
                                  )
                                }}
                              >
                                {zh ? '确认归档' : 'Confirm archive'}
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setConfirmApproveId(null)}
                              >
                                {zh ? '取消' : 'Cancel'}
                              </Button>
                            </>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setConfirmApproveId(entry.bead_id)}
                            >
                              {zh ? '批准归档' : 'Approve archive'}
                            </Button>
                          )
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setObjectiveId(entry.bead_id)
                              setComposeOpen(true)
                            }}
                          >
                            {zh ? '追加指令' : 'Reply'}
                          </Button>
                        )}
                      </div>
                    </div>
                    {entry.first_blocker || entry.next_action ? (
                      <div className={css.itemMeta}>
                        {entry.first_blocker
                          ? `${zh ? '阻塞' : 'Blocker'}: ${entry.first_blocker}`
                          : `${zh ? '下一步' : 'Next'}: ${entry.next_action}`}
                      </div>
                    ) : null}
                  </article>
                ))
              )}
            </div>
          )}
        </>
      ) : null}
    </section>
  )
}
