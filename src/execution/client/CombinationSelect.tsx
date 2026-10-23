import { createPortal } from 'react-dom'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  ModelCatalog,
  ModelReasoning,
  ModelSelection,
} from '@deepseek-ai/dsh-api-session-controller/types'
import {
  IconCheckOutlineRegular,
  IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular,
  MenuSurface,
  StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ExecutionCatalog, CombinationDefinition } from '../contracts/catalog.ts'
import type { HarnessCatalog } from '../contracts/sessions.ts'
import type { HarnessReasoningPreflight } from '../../contracts/types.ts'
import { useModelSelection } from './use-model-selection.ts'
import type { SelectionSource } from './use-model-selection.ts'
import css from './CombinationSelect.module.css'
import { modelDefaultEffort } from '../../shared/model-reasoning.ts'

import type { ExecutionCall as Call } from '../../shared/client/remote-call.ts'
type Choice = {
  combination: CombinationDefinition
  modelName: string
  harnessName: string
  source: string
  available: boolean
}
const measureStyle = { visibility: 'hidden', left: 0, top: 0 } as const
const effortLabels: Record<string, string> = {
  none: '关闭',
  default: '由 CLI 决定（旧记录）',
  off: '关闭',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大',
  ultra: '超高',
}
/** Effort ids that mean "thinking off" / "thinking on" rather than a strength level. */
const OFF_EFFORTS = new Set(['off', 'none', 'disabled', 'no'])
const ON_EFFORTS = new Set(['on', 'enabled', 'yes'])

function effortLabel(id: string, name: string): string {
  return effortLabels[id] ?? name
}

type ThinkingSwitch = {
  /** Effort id that turns thinking on, or undefined when the catalog offers no "on". */
  on?: string
  /** Effort id that turns thinking off, or undefined when the catalog offers no "off". */
  off?: string
}

/**
 * Recognize a thinking on/off switch in the official reasoning catalogue.
 *
 * A model whose only control is whether it thinks advertises exactly one enabled
 * and one disabled state. Such a model has no strength level, so it must not be
 * shown as an "推理强度" ladder: it is a switch, and the caller labels it as one.
 * Detection reads only the advertised ids — no provider or model is special-cased.
 */
function thinkingSwitch(reasoning: ModelReasoning): ThinkingSwitch | undefined {
  if (reasoning.efforts.length === 0) return undefined
  let on: string | undefined
  let off: string | undefined
  let matched = 0
  for (const effort of reasoning.efforts) {
    const id = effort.id.trim().toLowerCase()
    if (ON_EFFORTS.has(id)) {
      on = effort.id
      matched += 1
    } else if (OFF_EFFORTS.has(id)) {
      off = effort.id
      matched += 1
    }
  }
  if (matched !== reasoning.efforts.length || (on === undefined && off === undefined))
    return undefined
  return { ...(on === undefined ? {} : { on }), ...(off === undefined ? {} : { off }) }
}

function sourceLabel(provider: string, fallback: string): string {
  if (provider === 'opl-gateway') return 'OPL Gateway'
  if (provider === 'deepseek-account' || provider === 'deepseek-official') return 'DeepSeek 官方'
  return fallback
}
function choiceLabel(choice: Choice): string {
  return `${choice.modelName} · ${choice.harnessName}`
}

/** 官方 DSH 模型菜单的 OPL 组合投影：模型项代表“模型 + Harness”组合。 */
export function CombinationSelect({
  call,
  sessionId,
  locked,
  available,
  selectionSource,
  loadingLabel,
}: {
  available: boolean
  call: Call
  sessionId: string
  locked: boolean
  /** Official per-Session `modelSelection` projection face; absent without a retained Session. */
  selectionSource?: SelectionSource | undefined
  loadingLabel: string
}) {
  const [catalog, setCatalog] = useState<ExecutionCatalog>()
  const [loadingCatalog, setLoadingCatalog] = useState(true)
  const [loadingSelection, setLoadingSelection] = useState(true)
  const [availability, setAvailability] = useState<HarnessCatalog['combinations']>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [preflightRevision, setPreflightRevision] = useState(0)
  const [preflight, setPreflight] = useState<
    | { key: string; state: 'loading' }
    | { key: string; state: 'ready'; value: HarnessReasoningPreflight }
    | undefined
  >()
  const [pendingChoice, setPendingChoice] = useState<Choice>()
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<'root' | 'model' | 'effort'>('root')
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const focusIntent = useRef<'model' | 'effort' | 'drill' | null>(null)
  const addressed = useRef(sessionId)
  const reads = useRef(0)
  if (addressed.current !== sessionId) {
    addressed.current = sessionId
    reads.current += 1
  }
  const id = `opl-combination-${sessionId.replaceAll(/[^a-zA-Z0-9_-]/g, '-')}`
  useEffect(
    () => () => {
      reads.current += 1
    },
    [call, sessionId, available],
  )

  // The official selection projection is the authority; the RPC only bootstraps the
  // display and resolves the OPL combination bound to that official selection.
  const { selection, reload } = useModelSelection({
    sessionId,
    available,
    selectionSource,
    onError: setError,
    load: async (id: string) => {
      const read = ++reads.current
      const current = () => id === addressed.current && read === reads.current
      setLoadingCatalog(true)
      setLoadingSelection(true)
      void Promise.all([call('catalog'), call('combinations', {})])
        .then(([nextCatalog, nextAvailability]) => {
          if (!current()) return
          setCatalog(nextCatalog)
          setAvailability(nextAvailability)
          setError('')
        })
        .catch((cause: unknown) => {
          if (current()) setError(cause instanceof Error ? cause.message : '无法读取组合')
        })
        .finally(() => {
          if (current()) setLoadingCatalog(false)
        })
      try {
        return await call('model-selection', { sessionId: id })
      } finally {
        if (current()) setLoadingSelection(false)
      }
    },
  })

  const modelFor = (combination: CombinationDefinition) =>
    catalog?.models.find(
      (model) =>
        model.ref.provider === combination.modelRef.provider &&
        model.ref.model === combination.modelRef.model,
    )
  const harnessFor = (combination: CombinationDefinition) =>
    catalog?.harnesses.find((harness) => harness.id === combination.harnessRef)
  const choices = useMemo<Choice[]>(() => {
    if (!catalog) return []
    return catalog.combinations
      .filter((combination) => combination.enabled)
      .sort(
        (left, right) =>
          Number(!left.isDefault) - Number(!right.isDefault) || left.name.localeCompare(right.name),
      )
      .map((combination) => {
        const model = modelFor(combination)
        const harness = harnessFor(combination)
        const status = availability.find((item) => item.id === combination.id)
        return {
          combination,
          modelName: model?.name ?? combination.modelRef.model,
          harnessName: harness?.name ?? combination.harnessRef,
          source: sourceLabel(
            combination.modelRef.provider,
            model?.source ?? combination.modelRef.provider,
          ),
          available: status?.available === true,
        }
      })
  }, [availability, catalog, selection.combination])

  const visibleChoices = useMemo(() => {
    const seen = new Set<string>()
    return choices.filter((choice) => {
      if (!choice.available) return false
      const label = `${choice.source} · ${choiceLabel(choice)}`
      if (seen.has(label)) return false
      seen.add(label)
      return true
    })
  }, [choices])

  const selected =
    choices.find((choice) => choice.combination.id === selection.combination) ??
    choices.find(
      (choice) =>
        selection.current &&
        choice.combination.modelRef.provider === selection.current.provider &&
        choice.combination.modelRef.model === selection.current.model,
    )
  const currentModel = selection.current
    ? selection.groups
        .find((group) => group.id === selection.current?.provider)
        ?.models.find((model) => model.id === selection.current?.model)
    : undefined
  const reasoning = currentModel?.reasoning
  const externalCliControlsEffort =
    selected !== undefined && selected.combination.harnessRef !== 'dsh'
  const preflightKey = `${sessionId}:${selected?.combination.id ?? ''}`
  const livePreflight =
    externalCliControlsEffort && preflight?.key === preflightKey && preflight.state === 'ready'
      ? preflight.value
      : undefined
  const displayedReasoning = externalCliControlsEffort
    ? livePreflight?.status === 'known' && livePreflight.efforts.length > 0
      ? { efforts: livePreflight.efforts }
      : undefined
    : reasoning
  const effortSwitch =
    displayedReasoning === undefined ? undefined : thinkingSwitch(displayedReasoning)
  const effectiveEffort = externalCliControlsEffort
    ? livePreflight?.status === 'known' &&
      selection.current?.reasoningEffort !== undefined &&
      livePreflight.efforts.some((effort) => effort.id === selection.current?.reasoningEffort)
      ? selection.current.reasoningEffort
      : undefined
    : (selection.current?.reasoningEffort ?? modelDefaultEffort(currentModel?.id ?? '', reasoning))
  /**
   * A thinking switch reads as one state, not as a ladder: the trigger and the
   * drill-down cell both say 开启思考 / 关闭思考, so the top summary always names
   * the state that the next request actually uses.
   */
  const thinkingOn =
    effortSwitch === undefined
      ? undefined
      : effectiveEffort === effortSwitch.on
        ? true
        : effectiveEffort === effortSwitch.off
          ? false
          : undefined
  const thinkingLabel = thinkingOn === undefined ? undefined : thinkingOn ? '开启思考' : '关闭思考'
  const currentEffortLabel =
    thinkingLabel ??
    (effectiveEffort === undefined
      ? undefined
      : effortLabel(
          effectiveEffort,
          displayedReasoning?.efforts.find((effort) => effort.id === effectiveEffort)?.name ??
            effectiveEffort,
        ))
  const modelLabel = selected
    ? choiceLabel(selected)
    : (currentModel?.name ??
      selection.current?.model ??
      (loadingSelection ? loadingLabel : '请选择模型'))
  /** The row title differs by control kind: a switch is not a strength level. */
  const effortTitle = effortSwitch === undefined ? '推理强度' : '思考'
  const effortChoices =
    displayedReasoning === undefined
      ? []
      : effortSwitch !== undefined
        ? [
            ...(effortSwitch.on === undefined
              ? []
              : [{ key: 'switch:on', effort: effortSwitch.on, label: '开启思考' }]),
            ...(effortSwitch.off === undefined
              ? []
              : [{ key: 'switch:off', effort: effortSwitch.off, label: '关闭思考' }]),
          ]
        : displayedReasoning.efforts
            .filter((effort) => effort.id !== 'default')
            .map((effort) => ({
              key: `effort:${effort.id}`,
              effort: effort.id,
              label: effortLabel(effort.id, effort.name),
            }))

  const close = (restoreFocus = false) => {
    setOpen(false)
    setPane('root')
    if (restoreFocus) queueMicrotask(() => triggerRef.current?.focus())
  }
  const show = () => {
    if (open) {
      close(true)
      return
    }
    focusIntent.current = selection.current === null ? 'drill' : null
    setPane(selection.current === null ? 'model' : 'root')
    setOpen(true)
    setPreflightRevision((revision) => revision + 1)
    setError('')
    void reload(sessionId)
  }
  useEffect(() => {
    if (!selected || selected.combination.harnessRef === 'dsh') {
      setPreflight(undefined)
      return
    }
    const key = `${sessionId}:${selected.combination.id}`
    let current = true
    setPreflight({ key, state: 'loading' })
    void call('reasoning-preflight', { sessionId, combination: selected.combination.id })
      .then((value: HarnessReasoningPreflight) => {
        if (current) setPreflight({ key, state: 'ready', value })
      })
      .catch(() => {
        if (current)
          setPreflight({
            key,
            state: 'ready',
            value: { status: 'unavailable', efforts: [] },
          })
      })
    return () => {
      current = false
    }
  }, [call, selected?.combination.id, sessionId, preflightRevision])
  const drill = (next: 'model' | 'effort') => {
    focusIntent.current = 'drill'
    setPane(next)
  }
  const back = (from: 'model' | 'effort') => {
    focusIntent.current = from
    setPane('root')
  }

  const selectChoice = async (choice: Choice) => {
    if (busy || !choice.available) return
    if (choice.combination.id === selection.combination) {
      close(true)
      return
    }
    setBusy(true)
    setPendingChoice(choice)
    setError('')
    try {
      await call('select-combination', {
        sessionId,
        combination: choice.combination.id,
      })
      await reload(sessionId)
      close(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '选择失败')
    } finally {
      setBusy(false)
      setPendingChoice(undefined)
    }
  }
  const selectEffort = async (effort: string | undefined) => {
    if (!selection.current || busy) return
    if (effectiveEffort === effort) {
      close(true)
      return
    }
    setBusy(true)
    setError('')
    try {
      const { reasoningEffort: _ignored, ...base } = selection.current
      await call('select-effort', {
        sessionId,
        ...base,
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
      })
      await reload(sessionId)
      close(true)
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : effortSwitch === undefined
            ? '切换推理强度失败'
            : '切换思考失败',
      )
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (
        rootRef.current?.contains(event.target as Node) ||
        menuRef.current?.contains(event.target as Node)
      )
        return
      close()
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])
  useEffect(() => {
    if (!open || focusIntent.current === null) return
    const intent = focusIntent.current
    focusIntent.current = null
    if (intent === 'drill') {
      ;(
        (menuRef.current?.querySelector(
          '[role="menuitemradio"][aria-checked="true"]:not([disabled])',
        ) as HTMLElement | null) ??
        itemRefs.current.find((item) => item !== null && !item.disabled) ??
        triggerRef.current
      )?.focus()
      return
    }
    const target = itemRefs.current[intent === 'effort' ? 1 : 0]
    ;(target !== null && target !== undefined && !target.disabled
      ? target
      : triggerRef.current
    )?.focus()
  }, [open, pane])
  useLayoutEffect(() => {
    if (!open) {
      setMenuPos(null)
      return
    }
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const width = menuRef.current?.offsetWidth ?? 0
      const height = menuRef.current?.offsetHeight ?? 0
      setMenuPos({
        left: Math.min(Math.max(rect.right - width, 12), window.innerWidth - width - 12),
        top: Math.min(Math.max(rect.top - 8 - height, 12), window.innerHeight - height - 12),
      })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, pane, visibleChoices.length, error])

  const moveFocus = (offset: number) => {
    const items = itemRefs.current.filter(
      (item): item is HTMLButtonElement => item !== null && !item.disabled,
    )
    if (items.length === 0) return
    const currentIndex = items.findIndex((item) => item === document.activeElement)
    items[
      currentIndex < 0
        ? offset > 0
          ? 0
          : items.length - 1
        : (currentIndex + offset + items.length) % items.length
    ]?.focus()
  }
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!open) return
    if (event.key === 'Escape') {
      event.preventDefault()
      if (pane !== 'root' && selection.current !== null) back(pane)
      else close(true)
      return
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      if (event.shiftKey) {
        if (pane !== 'root' && selection.current !== null) back(pane)
        else close(true)
        return
      }
      const focused = document.activeElement
      if (focused instanceof HTMLButtonElement && itemRefs.current.includes(focused))
        focused.click()
      else
        (
          (menuRef.current?.querySelector(
            '[role="menuitemradio"][aria-checked="true"]:not([disabled])',
          ) as HTMLElement | null) ??
          itemRefs.current.find((item) => item !== null && !item.disabled)
        )?.focus()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveFocus(event.key === 'ArrowDown' ? 1 : -1)
    }
  }

  if (!available) return null
  itemRefs.current = []
  let itemIndex = 0
  const itemRef = () => {
    const index = itemIndex++
    return (node: HTMLButtonElement | null) => {
      itemRefs.current[index] = node
    }
  }
  const grouped = new Map<string, Choice[]>()
  for (const choice of visibleChoices)
    grouped.set(choice.source, [...(grouped.get(choice.source) ?? []), choice])

  return (
    <div ref={rootRef} className={css.root} onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        aria-label={`选择模型，当前 ${modelLabel}${currentEffortLabel ? `，${effortTitle} ${currentEffortLabel}` : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        title={modelLabel}
        aria-busy={busy}
        disabled={locked}
        onClick={show}
      >
        <span className={css.triggerLabel}>
          {pendingChoice ? choiceLabel(pendingChoice) : modelLabel}
        </span>
        {currentEffortLabel && <span className={css.triggerEffort}>{currentEffortLabel}</span>}
        {busy ? (
          <StateDot state="ongoing" />
        ) : (
          <IconChevronDownOutlineRegular
            className={`${css.chevron} ${open ? css.chevronOpen : ''}`}
          />
        )}
      </button>
      {open &&
        createPortal(
          <MenuSurface
            ref={menuRef}
            id={`${id}-menu`}
            className={css.menu}
            style={menuPos ?? measureStyle}
            role="menu"
            aria-label={`模型与${effortTitle}`}
          >
            {busy && (
              <div className={css.groupTitle} role="status">
                {pendingChoice
                  ? `正在切换到 ${choiceLabel(pendingChoice)}…`
                  : effortSwitch === undefined
                    ? '正在保存推理强度…'
                    : '正在保存思考设置…'}
              </div>
            )}
            {pane === 'root' && (
              <>
                <button
                  ref={itemRef()}
                  type="button"
                  role="menuitem"
                  className={css.cell}
                  onClick={() => drill('model')}
                >
                  <span className={css.cellLabel}>模型</span>
                  <span className={css.cellValue}>{modelLabel}</span>
                  <IconChevronRightOutlineRegular className={css.cellChevron} />
                </button>
                {displayedReasoning !== undefined && (
                  <button
                    ref={itemRef()}
                    type="button"
                    role="menuitem"
                    className={css.cell}
                    onClick={() => drill('effort')}
                  >
                    <span className={css.cellLabel}>{effortTitle}</span>
                    <span className={css.cellValue}>{currentEffortLabel ?? '默认'}</span>
                    <IconChevronRightOutlineRegular className={css.cellChevron} />
                  </button>
                )}
                {externalCliControlsEffort && preflight?.state === 'loading' && (
                  <div className={css.groupTitle} role="status">
                    正在读取推理设置…
                  </div>
                )}
                {externalCliControlsEffort && livePreflight?.status === 'unavailable' && (
                  <button
                    type="button"
                    className={css.cell}
                    onClick={() => setPreflightRevision((revision) => revision + 1)}
                  >
                    重新读取推理设置
                  </button>
                )}
              </>
            )}
            {pane === 'model' && (
              <>
                {error && (
                  <div className={css.error} role="alert">
                    {error}
                  </div>
                )}
                <div className={`${css.groups} scrollable`}>
                  {[...grouped].map(([source, choices]) => (
                    <section key={source} className={css.group} role="group" aria-label={source}>
                      <div className={css.groupTitle}>{source}</div>
                      {choices.map((choice) => {
                        const selectedChoice = selected?.combination.id === choice.combination.id
                        return (
                          <button
                            key={choice.combination.id}
                            ref={itemRef()}
                            type="button"
                            role="menuitemradio"
                            aria-checked={selectedChoice}
                            className={`${css.option} ${selectedChoice ? css.selected : ''}`}
                            disabled={busy}
                            title={`${source} · ${choiceLabel(choice)}`}
                            onClick={() => void selectChoice(choice)}
                          >
                            <span className={css.optionCopy}>
                              <span className={css.modelName}>{choiceLabel(choice)}</span>
                            </span>
                            <span className={css.check}>
                              {busy && pendingChoice?.combination.id === choice.combination.id ? (
                                <StateDot state="ongoing" />
                              ) : selectedChoice ? (
                                <IconCheckOutlineRegular />
                              ) : null}
                            </span>
                          </button>
                        )
                      })}
                    </section>
                  ))}
                  {visibleChoices.length === 0 && (
                    <div className={css.empty} role={loadingCatalog ? 'status' : undefined}>
                      {loadingCatalog ? loadingLabel : '当前没有可用的模型组合'}
                    </div>
                  )}
                </div>
              </>
            )}
            {pane === 'effort' && (
              <>
                {error && (
                  <div className={css.error} role="alert">
                    {error}
                  </div>
                )}
                {effortChoices.length === 0 ? (
                  <div className={css.empty}>
                    {effortSwitch === undefined
                      ? '当前模型未提供推理强度'
                      : '当前模型未提供思考开关'}
                  </div>
                ) : (
                  effortChoices.map((level) => {
                    const checked = effectiveEffort === level.effort
                    return (
                      <button
                        key={level.key}
                        ref={itemRef()}
                        type="button"
                        role="menuitemradio"
                        aria-checked={checked}
                        className={`${css.option} ${checked ? css.selected : ''}`}
                        disabled={busy}
                        onClick={() => void selectEffort(level.effort)}
                      >
                        <span className={css.optionCopy}>
                          <span className={css.modelName}>{level.label}</span>
                        </span>
                        {effortSwitch !== undefined ? (
                          // A thinking control is a switch, not a strength level: the
                          // track states 开启/关闭 at a glance while the label keeps
                          // the exact wording used by the official selection.
                          <span className={css.switch} data-on={checked ? 'true' : 'false'}>
                            <span className={css.switchThumb} />
                          </span>
                        ) : (
                          <span className={css.check}>
                            {checked ? <IconCheckOutlineRegular /> : null}
                          </span>
                        )}
                      </button>
                    )
                  })
                )}
              </>
            )}
          </MenuSurface>,
          document.body,
        )}
      {error && !open && (
        <span role="alert" className={css.errorInline}>
          {error}
        </span>
      )}
    </div>
  )
}
