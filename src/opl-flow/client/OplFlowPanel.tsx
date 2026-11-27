import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  OplFlowCarrier,
  OplFlowDashboardEnvelope,
  OplFlowInboxEntry,
  OplFlowSessionEntry,
} from '../contracts/index.ts'
import type { OplFlowCall } from './types.ts'
import {
  carrierLabel,
  chooseSmartTab,
  extractDashboardOccupants,
  extractDashboardSessions,
  filterSessions,
  formatBlockerText,
  formatRelativeTime,
  formatStatusLabel,
  isSubagentSession,
  summarizeWorkspaces,
  type CarrierFilter,
  type OplFlowViewTab,
  type SessionScopeFilter,
} from './model.ts'
import css from './OplFlowPanel.module.css'

const VIEW_TABS: readonly { id: OplFlowViewTab; zh: string; en: string }[] = [
  { id: 'attention', zh: '待我处理', en: 'Needs me' },
  { id: 'objectives', zh: '长期目标', en: 'Objectives' },
  { id: 'sessions', zh: '本机对话', en: 'Sessions' },
  { id: 'events', zh: '事件队列', en: 'Events' },
]

export interface OplFlowPanelProps {
  call: OplFlowCall
  locale: 'zh' | 'en'
  openSession: (sessionId: string) => void
  startSession: (workspacePath?: string) => void
}

export function OplFlowPanel({ call, locale, openSession, startSession }: OplFlowPanelProps) {
  const zh = locale === 'zh'
  const idBase = useId()
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])

  const [dashboard, setDashboard] = useState<OplFlowDashboardEnvelope | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [activeTab, setActiveTab] = useState<OplFlowViewTab | null>(null)
  const [sessionScope, setSessionScope] = useState<SessionScopeFilter>('running')
  const [sessionCarrier, setSessionCarrier] = useState<CarrierFilter>('all')
  const [showSubagents, setShowSubagents] = useState(false)
  const [sessionSearch, setSessionSearch] = useState('')
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
      if (next.state === 'ready' && next.data) {
        const defaultTab = chooseSmartTab(next.data)
        setActiveTab((prev) => prev ?? defaultTab)
        const all = extractDashboardSessions(next.data)
        const hasRunningPrimary = all.some((s) => s.status === 'active' && !isSubagentSession(s))
        if (!hasRunningPrimary) {
          setSessionScope('all')
        }
      }
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
  const effectiveTab: OplFlowViewTab = activeTab ?? (data ? chooseSmartTab(data) : 'attention')

  const allSessions = useMemo(() => extractDashboardSessions(data), [data])
  const occupants = useMemo(() => extractDashboardOccupants(data), [data])
  const wsSummary = useMemo(() => summarizeWorkspaces(occupants), [occupants])

  const attentionCount = (counts?.needs_action ?? 0) + (counts?.safe_to_archive ?? 0)
  const objectivesCount =
    (counts?.active_objectives ?? 0) + (counts?.blocked ?? 0) + (counts?.backlog ?? 0)
  const subagentCount = useMemo(
    () => counts?.subagent_sessions ?? allSessions.filter((s) => isSubagentSession(s)).length,
    [counts?.subagent_sessions, allSessions],
  )
  const runningPrimaryCount = useMemo(
    () =>
      counts?.running_sessions ??
      allSessions.filter((s) => s.status === 'active' && !isSubagentSession(s)).length,
    [counts?.running_sessions, allSessions],
  )
  const primaryTotalCount = useMemo(
    () => counts?.primary_sessions ?? allSessions.filter((s) => !isSubagentSession(s)).length,
    [counts?.primary_sessions, allSessions],
  )
  const visibleSessions = useMemo(
    () =>
      filterSessions(allSessions, {
        scope: sessionScope,
        carrier: sessionCarrier,
        includeSubagents: showSubagents,
        query: sessionSearch,
      }),
    [allSessions, sessionScope, sessionCarrier, showSubagents, sessionSearch],
  )

  const carrierRunningBreakdown = useMemo(() => {
    const running = allSessions.filter((s) => s.status === 'active' && !isSubagentSession(s))
    const codexN = running.filter((s) => s.carrier === 'codex').length
    const agyN = running.filter((s) => s.carrier === 'antigravity').length
    const dshN = running.filter((s) => s.carrier === 'dsh').length
    const parts: string[] = []
    if (codexN) parts.push(`Codex ${codexN}`)
    if (agyN) parts.push(`AntiGravity ${agyN}`)
    if (dshN) parts.push(`DSH ${dshN}`)
    return (
      parts.join(' · ') ||
      (zh ? `最近 ${primaryTotalCount} 个主对话` : `${primaryTotalCount} recent`)
    )
  }, [allSessions, primaryTotalCount, zh])

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

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = -1
    if (event.key === 'ArrowRight') next = (index + 1) % VIEW_TABS.length
    else if (event.key === 'ArrowLeft') next = (index - 1 + VIEW_TABS.length) % VIEW_TABS.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = VIEW_TABS.length - 1
    if (next < 0) return
    event.preventDefault()
    setActiveTab(VIEW_TABS[next]!.id)
    tabRefs.current[next]?.focus()
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
          <span className={css.pill}>
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

  function renderObjectiveRow(entry: OplFlowInboxEntry, isArchiveCandidate: boolean) {
    const remaining = entry.remaining ?? []
    const blockerText = formatBlockerText(entry.first_blocker, zh)
    return (
      <div className={css.row} key={entry.bead_id}>
        <div className={css.rowMain}>
          <div className={css.rowTitle}>
            <strong>{entry.title}</strong>
            <span className={css.pill}>
              {formatStatusLabel(entry.status || entry.category, zh)}
            </span>
            {entry.execution_carrier ? (
              <span className={css.pill}>{carrierLabel(entry.execution_carrier, zh)}</span>
            ) : null}
          </div>
          {blockerText || entry.next_action ? (
            <div className={css.rowMeta}>
              {blockerText ? <span>{`${zh ? '阻塞：' : 'Blocker: '}${blockerText}`}</span> : null}
              {blockerText && entry.next_action ? ' · ' : null}
              {entry.next_action ? (
                <span>{`${zh ? '下一步：' : 'Next: '}${entry.next_action}`}</span>
              ) : null}
            </div>
          ) : null}
          {remaining.length > 0 ? (
            <details className={css.rowDetails}>
              <summary>
                {zh
                  ? `剩余步骤（${remaining.length} 项）`
                  : `Remaining steps (${remaining.length})`}
              </summary>
              <ul>
                {remaining.map((step, i) => (
                  <li key={`${entry.bead_id}-rem-${i}`}>{step}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
        <div className={css.actions}>
          {renderObjectiveJump(entry)}
          {isArchiveCandidate ? (
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
                <Button size="sm" variant="outline" onClick={() => setConfirmApproveId(null)}>
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
    )
  }

  function renderSessionRow(sess: OplFlowSessionEntry) {
    const carrierName = carrierLabel(sess.carrier, zh)
    const displayTitle =
      sess.title ||
      (sess.workspace_label
        ? `${sess.workspace_label} · ${sess.model_label || carrierName}`
        : sess.model_label || sess.session_ref)
    const statusTone =
      sess.status === 'active' ? 'running' : sess.status === 'error' ? 'warn' : undefined
    return (
      <div className={css.row} key={sess.session_ref}>
        <div className={css.rowMain}>
          <div className={css.rowTitle}>
            <span className={css.pill} data-tone={statusTone}>
              <span className={css.dot} aria-hidden="true" />
              <span>{formatStatusLabel(sess.status || 'idle', zh)}</span>
            </span>
            <strong>{displayTitle}</strong>
            {sess.workspace_label ? <span className={css.pill}>{sess.workspace_label}</span> : null}
            {sess.bound_bead_id ? (
              <span className={css.pill}>{`Bead: ${sess.bound_bead_id}`}</span>
            ) : null}
          </div>
          <div className={css.rowMeta} title={sess.updated_at || undefined}>
            {`${carrierName}${sess.model_label && sess.model_label !== carrierName ? ` · ${sess.model_label}` : ''} · ${formatRelativeTime(sess.updated_at, zh)} · ${sess.bound_bead_id ? (zh ? '已纳管' : 'Managed') : zh ? '自由对话（防撞车）' : 'Unbound · guarded'}`}
          </div>
        </div>
        <div className={css.actions}>
          {sess.jump_mode === 'native_switch' && sess.session_id ? (
            <Button size="sm" variant="outline" onClick={() => openSession(sess.session_id!)}>
              {zh ? '切换 DSH 会话' : 'Switch to DSH chat'}
            </Button>
          ) : (
            <>
              <span className={css.pill}>
                {zh ? `外部载体：${carrierName}` : `External: ${carrierName}`}
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
    )
  }

  const serviceRunning = Boolean(data?.service?.running)
  const serviceBridge = data?.service?.bridge || 'auto'
  const needsActionList = data?.inbox?.needs_action ?? []
  const archiveList = data?.inbox?.safe_to_archive ?? []
  const activeObjectivesList = data?.inbox?.active_objectives ?? []
  const blockedList = data?.inbox?.blocked ?? []
  const backlogList = data?.inbox?.backlog ?? []
  const pendingEvents = data?.inbox?.pending_events ?? []
  const tabCountFor = (tab: OplFlowViewTab) => {
    if (tab === 'attention') return attentionCount
    if (tab === 'objectives') return objectivesCount
    if (tab === 'sessions') return runningPrimaryCount || primaryTotalCount
    return counts?.pending_events ?? 0
  }

  return (
    <section className={css.root} data-testid="opl-flow-dsh-panel">
      <header className={css.header}>
        <div className={css.headerLeft}>
          <div className={css.titleRow}>
            <h1>{zh ? 'OPL Flow 总控' : 'OPL Flow Control Tower'}</h1>
            {data ? (
              <span className={css.pill} data-tone={serviceRunning ? 'running' : undefined}>
                <span className={css.dot} aria-hidden="true" />
                <span>
                  {serviceRunning
                    ? zh
                      ? `自动路由 · ${serviceBridge}`
                      : `Auto router · ${serviceBridge}`
                    : zh
                      ? '路由已停止'
                      : 'Router stopped'}
                </span>
              </span>
            ) : null}
            {data?.instance_name ? <span className={css.pill}>{data.instance_name}</span> : null}
          </div>
          <details className={css.boundaryDetails}>
            <summary>{zh ? '定位与三端分工说明' : 'Scope & boundary'}</summary>
            <p>
              {zh
                ? '个人跨 Codex / AntiGravity / OPL DSH 的 Beads/Dolt 长期目标总账与零 Token 自动路由控制塔（不自建第二套聊天框）；推进对话直接切换或新建 DSH 原生会话。'
                : 'Personal cross-carrier Beads/Dolt ledger and zero-token auto-router control tower. Opens or launches native DSH sessions.'}
            </p>
          </details>
        </div>
        <div className={css.actions}>
          <Button size="sm" onClick={() => setComposeOpen((prev) => !prev)}>
            {zh ? '新建 / 投递任务' : 'New task'}
          </Button>
          {data ? (
            <>
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
                    ? '启动路由'
                    : 'Start router'}
              </Button>
            </>
          ) : null}
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

      <div aria-live="polite">
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
      </div>

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
          <div
            className={css.summaryStrip}
            role="region"
            aria-label={zh ? '总控关键指标' : 'Control tower summary'}
          >
            <button
              type="button"
              className={css.summaryTile}
              onClick={() => setActiveTab('attention')}
            >
              <span className={css.summaryLabel}>{zh ? '待我处理' : 'Needs me'}</span>
              <span className={css.summaryValue}>{attentionCount}</span>
              <span className={css.summaryHint}>
                {attentionCount > 0
                  ? zh
                    ? `拍板 ${counts?.needs_action ?? 0} · 归档 ${counts?.safe_to_archive ?? 0}`
                    : `${counts?.needs_action ?? 0} action`
                  : zh
                    ? '已清空'
                    : 'All clear'}
              </span>
            </button>
            <button
              type="button"
              className={css.summaryTile}
              onClick={() => setActiveTab('objectives')}
            >
              <span className={css.summaryLabel}>{zh ? '长期目标' : 'Objectives'}</span>
              <span className={css.summaryValue}>{counts?.active_objectives ?? 0}</span>
              <span className={css.summaryHint}>
                {zh
                  ? `进行中 ${counts?.active_objectives ?? 0} · 阻塞 ${counts?.blocked ?? 0} · 待排期 ${counts?.backlog ?? 0}`
                  : `${objectivesCount} tracked`}
              </span>
            </button>
            <button
              type="button"
              className={css.summaryTile}
              onClick={() => {
                setSessionScope('running')
                setActiveTab('sessions')
              }}
            >
              <span className={css.summaryLabel}>{zh ? '运行中对话' : 'Running chats'}</span>
              <span className={css.summaryValue}>{runningPrimaryCount}</span>
              <span className={css.summaryHint}>{carrierRunningBreakdown}</span>
            </button>
            <button
              type="button"
              className={css.summaryTile}
              onClick={() => {
                setSessionScope('running')
                setActiveTab('sessions')
              }}
            >
              <span className={css.summaryLabel}>{zh ? '工作区防撞车' : 'Workspace guard'}</span>
              <span className={css.summaryValue}>
                {counts?.unique_occupied_workspaces ?? wsSummary.uniqueCount}
              </span>
              <span className={css.summaryHint}>
                {wsSummary.collisions.length > 0
                  ? zh
                    ? `并发目录：${wsSummary.collisions.map((c) => `${c.workspace}(${c.count})`).join('、')}`
                    : `${wsSummary.collisions.length} concurrent`
                  : zh
                    ? '各工作区无冲突'
                    : 'No collisions'}
              </span>
            </button>
          </div>

          {composeOpen ? (
            <form className={css.card} onSubmit={(event) => void handleSubmit(event)}>
              <div className={css.formGrid}>
                <label className={css.field} htmlFor={`${idBase}-obj`}>
                  <span>{zh ? '目标编号（留空则新建）' : 'Objective ID'}</span>
                  <input
                    id={`${idBase}-obj`}
                    className={css.input}
                    value={objectiveId}
                    onChange={(e) => setObjectiveId(e.target.value)}
                    placeholder="opl-123"
                  />
                </label>
                {!objectiveId.trim() ? (
                  <label className={css.field} htmlFor={`${idBase}-title`}>
                    <span>{zh ? '目标标题（可选）' : 'Title'}</span>
                    <input
                      id={`${idBase}-title`}
                      className={css.input}
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                    />
                  </label>
                ) : null}
                <label className={css.field} htmlFor={`${idBase}-exec`}>
                  <span>{zh ? '执行载体' : 'Executor'}</span>
                  <select
                    id={`${idBase}-exec`}
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
                <label className={css.field} htmlFor={`${idBase}-mode`}>
                  <span>{zh ? '队列模式' : 'Mode'}</span>
                  <select
                    id={`${idBase}-mode`}
                    className={css.select}
                    value={executionMode}
                    onChange={(e) => setExecutionMode(e.target.value as 'active' | 'backlog')}
                  >
                    <option value="active">{zh ? '立即排入进行中' : 'Active'}</option>
                    <option value="backlog">{zh ? '暂存待排期' : 'Backlog'}</option>
                  </select>
                </label>
              </div>
              <label className={css.field} htmlFor={`${idBase}-msg`}>
                <span>{zh ? '任务内容或拍板指令' : 'Instruction'}</span>
                <textarea
                  id={`${idBase}-msg`}
                  className={css.textarea}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                />
              </label>
              <div className={css.actions}>
                <label className={css.checkInline} htmlFor={`${idBase}-now`}>
                  <input
                    id={`${idBase}-now`}
                    type="checkbox"
                    checked={runNow}
                    onChange={(e) => setRunNow(e.target.checked)}
                  />
                  <span>{zh ? '投递后立即执行一轮评估' : 'Tick immediately'}</span>
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
            aria-label={zh ? 'OPL Flow 视图切换' : 'Control tower views'}
          >
            {VIEW_TABS.map((tab, index) => (
              <button
                key={tab.id}
                ref={(el) => {
                  tabRefs.current[index] = el
                }}
                id={`${idBase}-tab-${tab.id}`}
                type="button"
                role="tab"
                className={css.tab}
                aria-selected={effectiveTab === tab.id}
                onKeyDown={(e) => handleTabKeyDown(e, index)}
                onClick={() => setActiveTab(tab.id)}
              >
                <span>{zh ? tab.zh : tab.en}</span>
                <span className={css.tabCount}>{tabCountFor(tab.id)}</span>
              </button>
            ))}
          </div>

          <div role="tabpanel" aria-labelledby={`${idBase}-tab-${effectiveTab}`}>
            {effectiveTab === 'attention' ? (
              attentionCount === 0 ? (
                <div className={css.surface}>
                  <div className={css.emptyState}>
                    <strong>
                      {zh ? '当前无需人工拍板或归档批准' : 'Nothing awaiting your decision'}
                    </strong>
                    <p className={css.notice}>
                      {zh
                        ? '有需要拍板的任务或完成待归档项时会自动汇总到这里。'
                        : 'Items needing input or archive confirmation appear here.'}
                    </p>
                  </div>
                </div>
              ) : (
                <div className={css.surface}>
                  {needsActionList.length > 0 ? (
                    <>
                      <div className={css.sectionHeader}>
                        <span>{zh ? '需你拍板' : 'Needs action'}</span>
                        <span>{needsActionList.length}</span>
                      </div>
                      {needsActionList.map((e) => renderObjectiveRow(e, false))}
                    </>
                  ) : null}
                  {archiveList.length > 0 ? (
                    <>
                      <div className={css.sectionHeader}>
                        <span>{zh ? '待批归档' : 'Ready to archive'}</span>
                        <span>{archiveList.length}</span>
                      </div>
                      {archiveList.map((e) => renderObjectiveRow(e, true))}
                    </>
                  ) : null}
                </div>
              )
            ) : effectiveTab === 'objectives' ? (
              objectivesCount === 0 ? (
                <div className={css.surface}>
                  <div className={css.emptyState}>
                    <strong>{zh ? '暂无纳入总账的长期目标' : 'No tracked objectives'}</strong>
                  </div>
                </div>
              ) : (
                <div className={css.surface}>
                  {activeObjectivesList.length > 0 ? (
                    <>
                      <div className={css.sectionHeader}>
                        <span>{zh ? '进行中' : 'Active'}</span>
                        <span>{activeObjectivesList.length}</span>
                      </div>
                      {activeObjectivesList.map((e) => renderObjectiveRow(e, false))}
                    </>
                  ) : null}
                  {blockedList.length > 0 ? (
                    <>
                      <div className={css.sectionHeader}>
                        <span>{zh ? '外部阻塞' : 'Blocked'}</span>
                        <span>{blockedList.length}</span>
                      </div>
                      {blockedList.map((e) => renderObjectiveRow(e, false))}
                    </>
                  ) : null}
                  {backlogList.length > 0 ? (
                    <>
                      <div className={css.sectionHeader}>
                        <span>{zh ? '待排期 / 冻结保留' : 'Backlog / Frozen'}</span>
                        <span>{backlogList.length}</span>
                      </div>
                      {backlogList.map((e) => renderObjectiveRow(e, false))}
                    </>
                  ) : null}
                </div>
              )
            ) : effectiveTab === 'sessions' ? (
              <>
                <div className={css.toolbar}>
                  <div
                    className={css.segmented}
                    role="group"
                    aria-label={zh ? '活跃范围' : 'Session status filter'}
                  >
                    <button
                      type="button"
                      className={css.segButton}
                      aria-pressed={sessionScope === 'running'}
                      onClick={() => setSessionScope('running')}
                    >
                      {zh ? `运行中 (${runningPrimaryCount})` : `Running (${runningPrimaryCount})`}
                    </button>
                    <button
                      type="button"
                      className={css.segButton}
                      aria-pressed={sessionScope === 'all'}
                      onClick={() => setSessionScope('all')}
                    >
                      {zh ? `全部近期 (${primaryTotalCount})` : `Recent (${primaryTotalCount})`}
                    </button>
                  </div>
                  <select
                    className={css.select}
                    aria-label={zh ? '载体筛选' : 'Filter carrier'}
                    value={sessionCarrier}
                    onChange={(e) => setSessionCarrier(e.target.value as CarrierFilter)}
                  >
                    <option value="all">{zh ? '全部载体' : 'All carriers'}</option>
                    <option value="codex">Codex</option>
                    <option value="antigravity">AntiGravity</option>
                    <option value="dsh">OPL DSH</option>
                  </select>
                  {subagentCount > 0 ? (
                    <label className={css.checkInline}>
                      <input
                        type="checkbox"
                        checked={showSubagents}
                        onChange={(e) => setShowSubagents(e.target.checked)}
                      />
                      <span>
                        {zh ? `显示子代理 (${subagentCount})` : `Subagents (${subagentCount})`}
                      </span>
                    </label>
                  ) : null}
                  <input
                    type="search"
                    className={`${css.input} ${css.searchInput}`}
                    aria-label={zh ? '搜索对话标题或工作区' : 'Search sessions'}
                    placeholder={zh ? '搜索标题、工作区或模型…' : 'Search title, workspace, model…'}
                    value={sessionSearch}
                    onChange={(e) => setSessionSearch(e.target.value)}
                  />
                </div>
                <div className={css.surface}>
                  {visibleSessions.length === 0 ? (
                    <div className={css.emptyState}>
                      <strong>{zh ? '当前筛选下无匹配对话' : 'No matching sessions'}</strong>
                    </div>
                  ) : (
                    visibleSessions.map((sess) => renderSessionRow(sess))
                  )}
                </div>
              </>
            ) : (
              <div className={css.surface}>
                {pendingEvents.length === 0 ? (
                  <div className={css.emptyState}>
                    <strong>{zh ? '当前无待处理事件' : 'No pending events'}</strong>
                  </div>
                ) : (
                  pendingEvents.map((ev) => (
                    <div className={css.row} key={ev.event_id}>
                      <div className={css.rowMain}>
                        <div className={css.rowTitle}>
                          <span className={css.pill}>{ev.event_type}</span>
                          <strong>{ev.objective_id}</strong>
                          <span className={css.pill}>{ev.status || 'pending'}</span>
                        </div>
                        {ev.summary ? <div className={css.rowMeta}>{ev.summary}</div> : null}
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </>
      ) : null}
    </section>
  )
}
