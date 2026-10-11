/** 停止后编辑入口。只用官方公开的会话输入动作，不替换任何官方 UI 部件。 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ExecutionCall } from '../../shared/client/remote-call.ts'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  describeOutcome,
  entryVisible,
  recoveryReadVisible,
  StopEditStateStore,
  unavailableReason,
  waitingStatus,
} from './stop-edit.ts'
import { attachmentNote, STOP_EDIT_COPY, STOP_EDIT_PHASE_LABEL } from './stop-edit-locales.ts'
import css from './StopEditControl.module.css'

interface ControlProps {
  sessionId: string
  inputActions: {
    setDraft(text: string): void
  }
  /** 官方会话输入状态；用于判断输入框里已经有内容时不覆盖用户草稿。 */
  useInput: SnapshotSelectorHook<InputState>
  /** 官方会话控制流的订阅：只在会话真的变化时刷新，不做轮询。 */
  subscribeSession?: (sessionId: string, listener: () => void) => () => void
  /** 官方 Workspace 导航动作；打开分支但不发送消息。 */
  openSession: (sessionId: string) => void
  call: ExecutionCall
  locked?: boolean
  /** 官方 toolbar activity 的展开与释放。 */
  onActiveChange?: (active: boolean) => void
}

/**
 * 入口组件。
 *
 * 刷新只由官方会话控制流的订阅驱动：新会话首轮之后按钮会随之更新，而不是定时轮询。
 * 填回草稿前先看官方输入状态里有没有内容——恢复出来的旧草稿绝不能盖掉用户正在写的
 * 东西；换会话之后到期的旧结果一律丢弃，不会写进新会话的输入框。
 *
 * 每一句话都对应一条 Host 事实：等待/暂无消息来自 `supported` 与 `busy`，不可用原因来自
 * `reason`，禁用原因来自边界自己的 `blockedReason`。组件不推断能力，也不细化 Host 没有
 * 报告过的进度。
 */
export function StopEditControl({
  sessionId,
  inputActions,
  useInput,
  subscribeSession,
  openSession,
  call,
  locked = false,
  onActiveChange,
}: ControlProps) {
  const latest = useRef({ sessionId, inputActions, call, draft: '' })
  latest.current = { sessionId, inputActions, call, draft: '' }
  const mounted = useRef(true)
  const applied = useRef('')
  const root = useRef<HTMLDivElement>(null)
  /**
   * 当前这段界面真正拥有的 store 身份，以及最近一次创建的 store。
   *
   * 换会话会新建 store，而旧 store 的在途回调仍会跑完。它们只能和自己创建时的那一段界面
   * 对话：任何晚到的失败或原文都不允许写进新会话。
   */
  const owner = useRef<object>({})
  const active = useRef<StopEditStateStore | undefined>(undefined)
  const [notice, setNotice] = useState('')
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [noticeError, setNoticeError] = useState(false)
  const [draftDismissed, setDraftDismissed] = useState(false)
  const [editingFinished, setEditingFinished] = useState(false)
  const [editingDismissed, setEditingDismissed] = useState(false)
  const editDraftObserved = useRef(false)
  const [placedDraft, setPlacedDraft] = useState('')
  const [createdBranch, setCreatedBranch] = useState<{ sessionId: string; title: string }>()
  const store = useMemo(() => {
    const token = {}
    owner.current = token
    const instance = new StopEditStateStore({
      load: (id) => latest.current.call('stop-edit-state', { sessionId: id }),
      run: (request) => latest.current.call('stop-edit', request),
      acknowledge: (request) => latest.current.call('stop-edit-acknowledge', request),
      // 清除待填草稿失败不能让用户以为原文已经处理完：如实显示这条固定诊断。
      // 晚到的失败只属于它真正所属的会话与仍然存在的那段界面，否则一律丢弃。
      onError: (message, failedSession) => {
        if (!mounted.current) return
        if (owner.current !== token) return
        if (failedSession !== latest.current.sessionId) return
        setNotice(message)
        setNoticeError(true)
        setDetailsOpen(true)
      },
    })
    active.current = instance
    return instance
  }, [sessionId])
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  // 只订阅输入框的文本这一个切片：用户在打字时不会因为别的状态变化而重跑整棵组件。
  const currentDraft = useInput((state) => state.draft) ?? ''
  // 每次渲染都刷新这份快照：await 之后必须读到“此刻”的输入框内容与所属会话，
  // 而不是点击那一刻的旧值，否则等待期间打的字会被旧原文盖掉。
  latest.current.draft = currentDraft

  useEffect(() => {
    mounted.current = true
    return () => {
      // 组件关闭：这一段 store 不再拥有任何界面，停止交付结果与提示。
      // Host 侧的持久草稿原样保留，等下一次安全恢复时重新读取。
      mounted.current = false
      active.current?.detach()
    }
  }, [])

  useEffect(() => {
    applied.current = ''
    setPlacedDraft('')
    setNotice('')
    setDetailsOpen(false)
    setNoticeError(false)
    setDraftDismissed(false)
    setEditingFinished(false)
    setEditingDismissed(false)
    editDraftObserved.current = false
    setCreatedBranch(undefined)
    const off = subscribeSession?.(sessionId, () => void store.load(sessionId))
    void store.load(sessionId)
    return () => off?.()
  }, [store, sessionId, subscribeSession])

  // 恢复出来的待填草稿只在输入框确实为空时落进去，绝不覆盖用户自己的输入。
  // 输入框里有内容时什么都不做：原文留在 Host 的持久草稿里，下面的待填原文区块继续展示。
  useEffect(() => {
    const draft = view.pendingDraft
    if (!mounted.current) return
    if (!draft || applied.current === draft.clientRequestId) return
    if (currentDraft !== '') return
    applied.current = draft.clientRequestId
    setPlacedDraft(draft.clientRequestId)
    inputActions.setDraft(draft.text)
    void store.acknowledge(sessionId, draft.clientRequestId)
  }, [view.pendingDraft, currentDraft, inputActions, sessionId, store])

  const visible = entryVisible(view)
  const waiting = waitingStatus(view)
  const unavailable = unavailableReason(view)
  const branch = createdBranch ?? view.editBranch
  const menuAvailable = visible || branch !== undefined
  const pending = view.pendingDraft
  // 已经填回输入框的原文不再当作“待回填”；Host 的持久草稿仍在，直到确认成功才清除。
  const showDraft =
    pending !== undefined && pending.text !== '' && pending.clientRequestId !== placedDraft
  const recovery = recoveryReadVisible(view)
  const working = view.phase === 'stopping' || view.phase === 'rewinding'
  const editableDraft =
    !!view.editSourceSessionId && !editingFinished && currentDraft !== '' && !view.busy
  const editing = editableDraft && !editingDismissed
  useEffect(() => {
    if (!view.editSourceSessionId) return
    if (currentDraft !== '') editDraftObserved.current = true
    if (view.busy || (editDraftObserved.current && !view.pendingDraft && currentDraft === ''))
      setEditingFinished(true)
  }, [view.editSourceSessionId, view.busy, view.pendingDraft, currentDraft])
  const expanded =
    view.phase === 'choosing' || working || (showDraft && !draftDismissed) || editing || detailsOpen
  useEffect(() => {
    onActiveChange?.(expanded)
    return () => onActiveChange?.(false)
  }, [expanded, onActiveChange])
  useEffect(() => {
    if (view.error) setDetailsOpen(true)
  }, [view.error])
  useEffect(() => {
    if (!expanded || working || typeof document.addEventListener !== 'function') return
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      if (editing && view.editSourceSessionId) openSession(view.editSourceSessionId)
      else {
        store.close()
        setDetailsOpen(false)
        setDraftDismissed(true)
      }
    }
    document.addEventListener('keydown', escape, true)
    return () => document.removeEventListener('keydown', escape, true)
  }, [expanded, working, editing, view.editSourceSessionId, openSession, store])
  useEffect(() => {
    if (!expanded || working) return
    const outside = (event: PointerEvent) => {
      const inside = editing
        ? (root.current?.closest('[data-composer-card]') ?? root.current)
        : root.current
      if (inside?.contains(event.target as Node)) return
      store.close()
      setDetailsOpen(false)
      setDraftDismissed(true)
      setEditingDismissed(true)
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [expanded, working, editing, store])
  if (
    !visible &&
    !waiting &&
    !unavailable &&
    !notice &&
    !recovery &&
    !branch &&
    !showDraft &&
    !view.editSourceSessionId
  )
    return null

  /** 用户主动把待填原文放回输入框；只有输入框为空时才允许，避免覆盖正在写的内容。 */
  const refillPendingDraft = () => {
    const draft = view.pendingDraft
    if (!draft || !mounted.current) return
    if (latest.current.draft !== '') return
    applied.current = draft.clientRequestId
    setPlacedDraft(draft.clientRequestId)
    latest.current.inputActions.setDraft(draft.text)
    void store.acknowledge(latest.current.sessionId, draft.clientRequestId)
  }

  const choose = async (boundaryId: string) => {
    const from = sessionId
    const token = owner.current
    const result = await store.choose(from, boundaryId)
    const now = latest.current
    // 迟到的结果只属于发起它的那次会话与那一段界面。组件已经卸载、store 已经被换掉、
    // 或者会话已经切走时，一律不写输入框、不确认草稿、也不做任何导航：
    // 原文留在 Host 的持久草稿里，等下一次安全恢复。
    if (!result || !mounted.current || owner.current !== token) return
    // React 换会话会新建 store，旧回调必须自行对照“当前的会话与输入框”，
    // 绝不能把旧原文写进新会话的 composer。
    if (now.sessionId !== from) return
    // 措辞按这一刻的事实：输入框里已经有草稿时，原文并没有被放回去。
    setNotice(describeOutcome(result, !result.moved && now.draft !== '' ? 'kept' : 'input'))
    setNoticeError(false)
    if (result.moved) {
      setCreatedBranch({ sessionId: result.sessionId, title: result.branchTitle })
      openSession(result.sessionId)
    }
    if (!result.moved && now.draft === '') {
      applied.current = result.clientRequestId
      setPlacedDraft(result.clientRequestId)
      now.inputActions.setDraft(result.draft)
      void store.acknowledge(from, result.clientRequestId)
    }
    // 回退之后边界集合已经变化，立刻按新会话刷新一次。
    void store.load(from)
  }

  const close = () => {
    if (working) return
    store.close()
    setDetailsOpen(false)
    setDraftDismissed(true)
  }
  return (
    <div
      ref={root}
      data-opl-stop-edit=""
      data-editing={editing || undefined}
      className={css.root}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || working) return
        event.stopPropagation()
        if (editing && view.editSourceSessionId) openSession(view.editSourceSessionId)
        else close()
      }}
    >
      {editing ? <span className={css.status}>{STOP_EDIT_COPY.editing}</span> : null}
      {editableDraft && editingDismissed ? (
        <button type="button" className={css.trigger} onClick={() => setEditingDismissed(false)}>
          {STOP_EDIT_PHASE_LABEL.idle}
        </button>
      ) : null}
      {menuAvailable && !editing ? (
        <button
          type="button"
          className={css.trigger}
          aria-expanded={view.phase === 'choosing'}
          aria-busy={working}
          disabled={working || locked}
          title={STOP_EDIT_COPY.panelHint}
          onClick={() => (view.phase === 'choosing' ? close() : store.open())}
        >
          {view.phase === 'choosing'
            ? STOP_EDIT_PHASE_LABEL.idle
            : STOP_EDIT_PHASE_LABEL[view.phase]}
        </button>
      ) : null}
      {!menuAvailable && !editableDraft && ((waiting && view.busy) || unavailable) ? (
        <button type="button" className={css.trigger} disabled title={waiting ?? unavailable}>
          {STOP_EDIT_PHASE_LABEL.idle}
        </button>
      ) : null}
      {menuAvailable && view.phase === 'choosing' ? (
        <div className={css.panel} role="menu">
          <div className={css.title} title={STOP_EDIT_COPY.panelHint}>
            {STOP_EDIT_COPY.panelTitle}
          </div>
          {view.busy ? <div className={css.busy}>{STOP_EDIT_COPY.busyNote}</div> : null}
          {(visible ? [...view.boundaries].reverse() : []).map((boundary) => (
            <button
              key={boundary.id}
              type="button"
              role="menuitem"
              className={css.row}
              disabled={working || locked || boundary.blocked === true}
              title={boundary.blocked ? boundary.blockedReason : boundary.contentHead}
              onClick={() => void choose(boundary.id)}
            >
              <span className={css.head}>
                {boundary.contentHead || STOP_EDIT_COPY.emptyMessage}
              </span>
              <span className={css.meta}>
                {boundary.first ? STOP_EDIT_COPY.firstMessage : ''}
                {boundary.attachmentCount
                  ? `${boundary.first ? ' · ' : ''}${attachmentNote(boundary.attachmentCount)}`
                  : ''}
              </span>
              {boundary.blocked ? (
                <span className={css.blocked}>{boundary.blockedReason}</span>
              ) : null}
            </button>
          ))}
          {branch ? (
            <button
              type="button"
              role="menuitem"
              className={css.trigger}
              title={branch.title}
              disabled={working || locked}
              onClick={() => openSession(branch.sessionId)}
            >
              {STOP_EDIT_COPY.returnToEdit}
            </button>
          ) : null}
          <button type="button" className={css.trigger} onClick={close}>
            {STOP_EDIT_COPY.cancel}
          </button>
        </div>
      ) : null}
      {showDraft && pending && !draftDismissed ? (
        <div className={css.panel}>
          <div className={css.draftTitle}>{STOP_EDIT_COPY.draftTitle}</div>
          <div className={css.draftText}>{pending.text}</div>
          {currentDraft !== '' ? <div className={css.hint}>{STOP_EDIT_COPY.draftKept}</div> : null}
          <button
            type="button"
            className={css.refill}
            disabled={currentDraft !== ''}
            title={currentDraft !== '' ? STOP_EDIT_COPY.draftRefillBlocked : pending.text}
            onClick={refillPendingDraft}
          >
            {STOP_EDIT_COPY.draftRefill}
          </button>
          <button type="button" className={css.trigger} onClick={close}>
            {STOP_EDIT_COPY.close}
          </button>
        </div>
      ) : null}
      {showDraft && draftDismissed ? (
        <button type="button" className={css.trigger} onClick={() => setDraftDismissed(false)}>
          {STOP_EDIT_COPY.draftTitle}
        </button>
      ) : null}
      {notice && !noticeError && !detailsOpen && !branch && !editing && !showDraft ? (
        <span className={css.status} title={notice}>
          {STOP_EDIT_COPY.done}
        </span>
      ) : null}
      {noticeError && !detailsOpen ? (
        <button type="button" className={css.recovery} onClick={() => setDetailsOpen(true)}>
          {STOP_EDIT_COPY.showNotice}
        </button>
      ) : null}
      {view.editSourceSessionId && !editingDismissed ? (
        <button
          type="button"
          className={css.trigger}
          title={STOP_EDIT_COPY.returnHint}
          disabled={working}
          onClick={() => openSession(view.editSourceSessionId!)}
        >
          {STOP_EDIT_COPY.returnSource}
        </button>
      ) : null}
      {recovery ? (
        <div className={detailsOpen ? css.panel : undefined}>
          {detailsOpen ? (
            <>
              {view.error ? <div>{view.error}</div> : null}
              {unavailable ? <div>{unavailable}</div> : null}
              <button
                type="button"
                className={css.recovery}
                title={STOP_EDIT_COPY.recoveryReadHint}
                onClick={() => void store.load(sessionId)}
              >
                {STOP_EDIT_COPY.recoveryRead}
              </button>
              <button type="button" className={css.trigger} onClick={close}>
                {STOP_EDIT_COPY.close}
              </button>
            </>
          ) : (
            <button type="button" className={css.recovery} onClick={() => setDetailsOpen(true)}>
              {STOP_EDIT_COPY.recoveryRead}
            </button>
          )}
        </div>
      ) : null}
      {notice && detailsOpen && !recovery ? (
        <div className={css.panel}>
          <div className={css.error}>{notice}</div>
          <button type="button" className={css.trigger} onClick={close}>
            {STOP_EDIT_COPY.close}
          </button>
        </div>
      ) : null}
    </div>
  )
}
