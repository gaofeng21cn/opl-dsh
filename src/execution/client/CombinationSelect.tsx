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
  MenuGroup,
  MenuSurface,
  StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ExecutionCatalog, CombinationDefinition } from '../contracts/catalog.ts'
import type { HarnessCatalog } from '../contracts/sessions.ts'
import type { HarnessInstallation, HarnessReasoningPreflight } from '../../contracts/types.ts'
import { harnessDirectoryOrder } from '../contracts/harness-groups.ts'
import { isOfficialPairing, officialHarnessFor } from '../contracts/official-harnesses.ts'
import type { PendingCombination } from './pending-combination.ts'
import { useModelSelection } from './use-model-selection.ts'
import type { SelectionSource } from './use-model-selection.ts'
import css from './CombinationSelect.module.css'
import { modelDefaultEffort } from '../../shared/model-reasoning.ts'
import { displayModelName, executionModelRefKey } from '../../shared/models.ts'

import type { ExecutionCall as Call } from '../../shared/client/remote-call.ts'
type Choice = {
  combination: CombinationDefinition
  modelName: string
  harnessName: string
  source: string
  available: boolean
}
type EngineChoice = {
  harnessRef: string
  harnessName: string
  existingChoice?: Choice
  available: boolean
  installable: boolean
  installing: boolean
  isRecommended: boolean
  isDefault: boolean
  isSelected: boolean
  statusText?: string
}

/** Controls supplied by the official model-menu extension points. */
export interface OfficialModelMenuControls {
  locked: boolean
  dismiss: () => void
  reportFailure: (message: string) => void
}

/** Presentation used when the official DSH model menu owns the trigger. */
export type CombinationSelectVariant = 'legacy' | 'pane'
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

function modelFor(catalog: ExecutionCatalog, combination: CombinationDefinition) {
  return catalog.models.find(
    (model) =>
      model.ref.provider === combination.modelRef.provider &&
      model.ref.model === combination.modelRef.model,
  )
}

function harnessFor(catalog: ExecutionCatalog, combination: CombinationDefinition) {
  return catalog.harnesses.find((harness) => harness.id === combination.harnessRef)
}

function sameModel(
  left: ModelSelection | null | undefined,
  right: ModelSelection | null | undefined,
) {
  return (
    left?.provider !== undefined &&
    right?.provider !== undefined &&
    executionModelRefKey(left) === executionModelRefKey(right)
  )
}

/** 官方 DSH 模型菜单的 OPL 组合投影：模型项代表“模型 + Harness”组合。 */
export function CombinationSelect({
  call,
  sessionId,
  locked,
  available,
  selectionSource,
  loadingLabel,
  pendingCombination,
  variant = 'legacy',
  officialControls,
}: {
  pendingCombination?: PendingCombination
  available: boolean
  call: Call
  sessionId: string
  locked: boolean
  /** Official per-Session `modelSelection` projection face; absent without a retained Session. */
  selectionSource?: SelectionSource | undefined
  loadingLabel: string
  /** Render only the OPL detail pane inside the official model menu. */
  variant?: CombinationSelectVariant
  /** Controls used by the official menu owner when this is a detail pane. */
  officialControls?: OfficialModelMenuControls
}) {
  const inOfficialPane = variant === 'pane'
  const [catalog, setCatalog] = useState<ExecutionCatalog>()
  const [loadingCatalog, setLoadingCatalog] = useState(true)
  const [availabilityLoading, setAvailabilityLoading] = useState(true)
  const [loadingSelection, setLoadingSelection] = useState(true)
  const [availability, setAvailability] = useState<HarnessCatalog['combinations']>([])
  const [installations, setInstallations] = useState<HarnessInstallation[]>([])
  const [installationsLoaded, setInstallationsLoaded] = useState(!inOfficialPane)
  const [installingHarness, setInstallingHarness] = useState<string>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [preflightRevision, setPreflightRevision] = useState(0)
  const [preflight, setPreflight] = useState<
    | {
        key: string
        state: 'loading' | 'ready'
        value?: HarnessReasoningPreflight
        requestedEffort?: string | undefined
      }
    | undefined
  >()
  const [pendingChoice, setPendingChoice] = useState<Choice>()
  const [open, setOpen] = useState(inOfficialPane)
  const [paneState, setPane] = useState<'root' | 'model' | 'effort'>('root')
  const renderPane = inOfficialPane ? 'model' : paneState
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
      setAvailabilityLoading(true)
      setLoadingSelection(true)
      if (inOfficialPane) setInstallationsLoaded(false)
      void call('catalog')
        .then((nextCatalog) => {
          if (!current()) return
          setCatalog(nextCatalog)
          setLoadingCatalog(false)
        })
        .catch((cause: unknown) => {
          if (current()) setError(cause instanceof Error ? cause.message : '无法读取组合')
        })
        .finally(() => {
          if (current()) setLoadingCatalog(false)
        })
      void call('combinations', {})
        .then((nextAvailability) => {
          if (!current()) return
          setAvailability(nextAvailability)
          setAvailabilityLoading(false)
          setError('')
        })
        .catch((cause: unknown) => {
          if (current()) setError(cause instanceof Error ? cause.message : '无法读取执行引擎')
        })
        .finally(() => {
          if (current()) setAvailabilityLoading(false)
        })
      if (inOfficialPane) {
        void call('harness-installations')
          .then((nextInstallations) => {
            if (current()) setInstallations(nextInstallations)
          })
          .catch(() => {})
          .finally(() => {
            if (current()) setInstallationsLoaded(true)
          })
      }
      try {
        return await call('model-selection', { sessionId: id })
      } finally {
        if (current()) setLoadingSelection(false)
      }
    },
  })

  const choices = useMemo<Choice[]>(() => {
    if (!catalog) return []
    return catalog.combinations
      .filter((combination) => combination.enabled)
      .sort(
        (left, right) =>
          Number(!left.isDefault) - Number(!right.isDefault) || left.name.localeCompare(right.name),
      )
      .map((combination) => {
        const model = modelFor(catalog, combination)
        const harness = harnessFor(catalog, combination)
        const status = availability.find((item) => item.id === combination.id)
        return {
          combination,
          modelName: model?.name ?? displayModelName(combination.modelRef),
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
      if (!availabilityLoading && !choice.available) return false
      const label = `${choice.source} · ${choiceLabel(choice)}`
      if (seen.has(label)) return false
      seen.add(label)
      return true
    })
  }, [availabilityLoading, choices])

  const paneChoices = useMemo(
    () =>
      inOfficialPane
        ? visibleChoices.filter((choice) =>
            sameModel(choice.combination.modelRef, selection.current),
          )
        : visibleChoices,
    [inOfficialPane, selection.current, visibleChoices],
  )

  const engineChoices = useMemo<EngineChoice[]>(() => {
    if (!inOfficialPane || !catalog || !selection.current) return []
    const currentModelRef = {
      provider: selection.current.provider,
      model: selection.current.model,
    }
    const pairingRefs =
      catalog.supportedPairings?.find((item) => sameModel(item.modelRef, currentModelRef))
        ?.harnessRefs ?? []
    const enabledForModel = choices.filter((choice) =>
      sameModel(choice.combination.modelRef, currentModelRef),
    )
    const candidateIds = new Set<string>([
      ...pairingRefs,
      ...enabledForModel.map((choice) => choice.combination.harnessRef),
    ])
    const recommendedId =
      officialHarnessFor(currentModelRef) ??
      catalog.recommendations?.find((item) => sameModel(item.modelRef, currentModelRef))?.harnessRef
    return [...candidateIds]
      .map((harnessRef) => {
        const harness = catalog.harnesses.find((item) => item.id === harnessRef)
        const harnessName = harness?.name ?? harnessRef
        const existingChoice = enabledForModel.find(
          (choice) => choice.combination.harnessRef === harnessRef,
        )
        const availEntry = existingChoice
          ? availability.find((item) => item.id === existingChoice.combination.id)
          : undefined
        const installation = installations.find((item) => item.id === harnessRef)
        const available =
          availEntry !== undefined
            ? availEntry.available
            : harnessRef === 'dsh'
              ? true
              : installation !== undefined
                ? installation.installed && installation.runnable
                : existingChoice !== undefined
                  ? existingChoice.available
                  : installationsLoaded && installations.length === 0
        const installing =
          installingHarness === harnessRef || installation?.maintenance?.state === 'running'
        const isRecommended =
          harnessRef === recommendedId ||
          isOfficialPairing(harnessRef, currentModelRef) ||
          (catalog.recommendations?.some(
            (item) => sameModel(item.modelRef, currentModelRef) && item.harnessRef === harnessRef,
          ) ??
            false)
        const statusText = !available
          ? installing
            ? '安装中…'
            : installation?.installed && installation.verification === 'failed'
              ? '需要处理'
              : '未安装'
          : undefined
        return {
          harnessRef,
          harnessName,
          ...(existingChoice ? { existingChoice } : {}),
          available,
          installable: installation?.maintenanceAction === 'install',
          installing,
          isRecommended,
          isDefault: existingChoice?.combination.isDefault === true,
          isSelected:
            existingChoice !== undefined && existingChoice.combination.id === selection.combination,
          ...(statusText ? { statusText } : {}),
        }
      })
      .sort(
        (left, right) =>
          Number(right.available) - Number(left.available) ||
          Number(right.isSelected) - Number(left.isSelected) ||
          Number(right.isDefault) - Number(left.isDefault) ||
          Number(right.isRecommended) - Number(left.isRecommended) ||
          Number(right.harnessRef === 'dsh') - Number(left.harnessRef === 'dsh') ||
          harnessDirectoryOrder(left.harnessRef, right.harnessRef),
      )
  }, [
    availability,
    catalog,
    choices,
    inOfficialPane,
    installations,
    installationsLoaded,
    installingHarness,
    selection.combination,
    selection.current,
  ])

  const selected = choices.find(
    (choice) =>
      choice.combination.id === selection.combination &&
      sameModel(choice.combination.modelRef, selection.current),
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
    externalCliControlsEffort && preflight?.key === preflightKey ? preflight.value : undefined
  const confirmedEffort =
    preflight?.requestedEffort === selection.current?.reasoningEffort &&
    livePreflight?.status === 'known' &&
    livePreflight.efforts.some((effort) => effort.id === livePreflight.currentEffort)
      ? livePreflight.currentEffort
      : undefined
  const displayedReasoning = externalCliControlsEffort
    ? livePreflight?.status === 'known' && livePreflight.efforts.length > 0
      ? { efforts: livePreflight.efforts }
      : undefined
    : selected?.combination.harnessRef === 'dsh' && reasoning?.efforts.length
      ? reasoning
      : undefined
  const effortSwitch =
    displayedReasoning === undefined ? undefined : thinkingSwitch(displayedReasoning)
  const offOnly = effortSwitch?.off !== undefined && effortSwitch.on === undefined
  const providerOwnsEffort =
    selected !== undefined &&
    ['codex', 'claude', 'minimax-code'].includes(selected.combination.harnessRef)
  const providerEffort =
    selection.current?.reasoningEffort ?? modelDefaultEffort(currentModel?.id ?? '', reasoning)
  const requestedEffort = externalCliControlsEffort
    ? selection.effortSource === 'harness'
      ? selection.current?.reasoningEffort
      : (confirmedEffort ??
        (providerOwnsEffort && reasoning?.efforts.some((effort) => effort.id === providerEffort)
          ? providerEffort
          : livePreflight?.status === 'known' &&
              livePreflight.efforts.some(
                (effort) => effort.id === selection.current?.reasoningEffort,
              )
            ? selection.current?.reasoningEffort
            : undefined))
    : (selection.current?.reasoningEffort ?? modelDefaultEffort(currentModel?.id ?? '', reasoning))
  const effectiveEffort =
    externalCliControlsEffort && livePreflight?.status === 'known'
      ? livePreflight.efforts.some((effort) => effort.id === requestedEffort)
        ? requestedEffort
        : confirmedEffort
      : externalCliControlsEffort &&
          (selection.effortSource === 'harness' ||
            (providerOwnsEffort &&
              (preflight?.key !== preflightKey || preflight.state === 'loading')))
        ? requestedEffort
        : displayedReasoning?.efforts.some((effort) => effort.id === requestedEffort)
          ? requestedEffort
          : undefined
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
  const currentEffortLabel = offOnly
    ? undefined
    : (thinkingLabel ??
      (effectiveEffort === undefined
        ? undefined
        : effortLabel(
            effectiveEffort,
            displayedReasoning?.efforts.find((effort) => effort.id === effectiveEffort)?.name ??
              effectiveEffort,
          )))
  const unresolvedCombination =
    !selected &&
    !loadingSelection &&
    choices.some((choice) => sameModel(choice.combination.modelRef, selection.current))
  const modelLabel = selected
    ? choiceLabel(selected)
    : (currentModel?.name ??
        selection.current?.model ??
        (loadingSelection ? loadingLabel : '请选择模型')) +
      (unresolvedCombination ? ' · 请选择执行组合' : '')
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
    if (inOfficialPane) {
      officialControls?.dismiss()
      return
    }
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
    setError('')
    void reload(sessionId)
  }
  useEffect(() => {
    if (!selected || selected.combination.harnessRef === 'dsh') {
      setPreflight(undefined)
      return
    }
    if (!available || locked) return
    const key = `${sessionId}:${selected.combination.id}`
    const requestedEffort = selection.current?.reasoningEffort
    const combination = selected.combination.id
    let current = true
    let retry: ReturnType<typeof setTimeout> | undefined
    const query = async (attempt: number) => {
      if (!current) return
      setPreflight((previous) => ({
        ...(previous?.key === key ? previous : { key }),
        state: 'loading',
      }))
      let value: HarnessReasoningPreflight
      try {
        value = await call('reasoning-preflight', { sessionId, combination })
      } catch {
        value = { status: 'unavailable', efforts: [] }
      }
      if (!current) return
      // A new Session may not exist on the Host until its first control update.
      // Retry only the unavailable read, then leave recovery to a user action or unlock.
      if (value.status === 'unavailable' && attempt < 2) {
        retry = setTimeout(() => void query(attempt + 1), attempt === 0 ? 500 : 1500)
        return
      }
      setPreflight((previous) => {
        if (
          value.status === 'unavailable' &&
          previous?.key === key &&
          previous.value?.status === 'known'
        )
          return { ...previous, state: 'ready' }
        return { key, state: 'ready', value, requestedEffort }
      })
    }
    void query(0)
    return () => {
      current = false
      clearTimeout(retry)
    }
  }, [
    call,
    selected?.combination.id,
    selection.current?.reasoningEffort,
    sessionId,
    available,
    locked,
    preflightRevision,
  ])
  const drill = (next: 'model' | 'effort') => {
    focusIntent.current = 'drill'
    setPane(next)
  }
  const back = (from: 'model' | 'effort') => {
    focusIntent.current = from
    setPane('root')
  }

  useEffect(() => {
    if (!inOfficialPane) return
    if (!installingHarness && !installations.some((item) => item.maintenance?.state === 'running'))
      return
    let active = true
    const timer = setTimeout(() => {
      void call('harness-installations')
        .then((next) => {
          if (!active) return
          setInstallations(next)
          setInstallationsLoaded(true)
          const stillRunning = next.some((item) => item.maintenance?.state === 'running')
          if (!stillRunning) {
            const failed = installingHarness
              ? next.find((item) => item.id === installingHarness)
              : undefined
            setInstallingHarness(undefined)
            if (failed?.maintenance?.state === 'failed') {
              setError(
                failed.maintenance.message.split('\n')[0] || '安装未完成，请打开设置检查路径',
              )
            } else {
              void reload(sessionId)
            }
          }
        })
        .catch(() => {})
    }, 1500)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [call, inOfficialPane, installations, installingHarness, reload, sessionId])

  const selectChoice = async (choice: Choice) => {
    if (busy || availabilityLoading || !choice.available) return
    if (
      choice.combination.id === selection.combination &&
      !pendingCombination?.needsConfirmation(sessionId)
    ) {
      close(true)
      return
    }
    setBusy(true)
    setPendingChoice(choice)
    setError('')
    try {
      const write = () =>
        call('select-combination', { sessionId, combination: choice.combination.id })
      await (pendingCombination ? pendingCombination.select(sessionId, write) : write())
      await reload(sessionId)
      close(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '选择失败')
    } finally {
      setBusy(false)
      setPendingChoice(undefined)
    }
  }

  const selectEngine = async (engine: EngineChoice) => {
    if (busy || !engine.available || !selection.current) return
    if (engine.isSelected && !pendingCombination?.needsConfirmation(sessionId)) {
      close(true)
      return
    }
    if (engine.existingChoice) {
      await selectChoice(engine.existingChoice)
      return
    }
    setBusy(true)
    setError('')
    try {
      const currentRef = {
        provider: selection.current.provider,
        model: selection.current.model,
      }
      const write = () =>
        call('select-model-harness', {
          sessionId,
          modelRef: currentRef,
          harnessRef: engine.harnessRef,
        })
      await (pendingCombination ? pendingCombination.select(sessionId, write) : write())
      await reload(sessionId)
      close(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '切换执行引擎失败')
    } finally {
      setBusy(false)
    }
  }

  const setDefaultEngine = async (engine: EngineChoice) => {
    if (busy || !engine.available || !selection.current) return
    setBusy(true)
    setError('')
    try {
      await call('select-model-harness', {
        sessionId,
        modelRef: {
          provider: selection.current.provider,
          model: selection.current.model,
        },
        harnessRef: engine.harnessRef,
        setAsDefault: true,
      })
      await reload(sessionId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '设为默认引擎失败')
    } finally {
      setBusy(false)
    }
  }

  const installEngine = async (harnessRef: string) => {
    if (busy || installingHarness) return
    setInstallingHarness(harnessRef)
    setError('')
    try {
      await call('harness-update', { id: harnessRef })
      const [nextInstallations, nextAvailability] = await Promise.all([
        call('harness-installations').catch(() => installations),
        call('combinations', {}).catch(() => availability),
      ])
      setInstallations(nextInstallations)
      setInstallationsLoaded(true)
      setAvailability(nextAvailability)
      const updated = nextInstallations.find((item) => item.id === harnessRef)
      if (updated?.maintenance?.state === 'failed') {
        setError(updated.maintenance.message.split('\n')[0] || '安装未完成，请打开设置检查路径')
        setInstallingHarness(undefined)
      } else if (updated?.maintenance?.state !== 'running') {
        setInstallingHarness(undefined)
        await reload(sessionId)
      }
    } catch (cause) {
      setInstallingHarness(undefined)
      setError(cause instanceof Error ? cause.message : '启动安装器失败')
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
  }, [open, paneState])
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
  }, [open, paneState, visibleChoices.length, error])

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
      if (paneState !== 'root' && selection.current !== null) back(paneState)
      else close(true)
      return
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      if (event.shiftKey) {
        if (paneState !== 'root' && selection.current !== null) back(paneState)
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
  for (const choice of paneChoices)
    grouped.set(choice.source, [...(grouped.get(choice.source) ?? []), choice])

  const menuBody = (
    <>
      {busy && (
        <div className={css.groupTitle} role="status">
          {pendingChoice
            ? `正在切换到 ${choiceLabel(pendingChoice)}…`
            : effortSwitch === undefined
              ? '正在保存推理强度…'
              : '正在保存思考设置…'}
        </div>
      )}
      {renderPane === 'root' && (
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
          {displayedReasoning !== undefined && !offOnly && (
            <button
              ref={itemRef()}
              type="button"
              role="menuitem"
              className={css.cell}
              onClick={() => drill('effort')}
            >
              <span className={css.cellLabel}>{effortTitle}</span>
              <span className={css.cellValue}>{currentEffortLabel ?? '未报告当前档位'}</span>
              <IconChevronRightOutlineRegular className={css.cellChevron} />
            </button>
          )}
          {externalCliControlsEffort &&
            preflight?.key === preflightKey &&
            preflight.state === 'loading' && (
              <div className={css.groupTitle} role="status">
                正在读取推理设置…
              </div>
            )}
          {externalCliControlsEffort &&
            livePreflight?.status === 'unavailable' &&
            preflight?.state === 'ready' && (
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
      {renderPane === 'model' && (
        <>
          {error && (
            <div className={css.error} role="alert">
              {error}
            </div>
          )}
          {inOfficialPane ? (
            (() => {
              const availableEngines = engineChoices.filter((item) => item.available)
              const unavailableEngines = engineChoices.filter((item) => !item.available)
              const selectedEngine = availableEngines.find((item) => item.isSelected)
              const missingRecommended = unavailableEngines.find((item) => item.isRecommended)
              const dshAvailable = availableEngines.some((item) => item.harnessRef === 'dsh')
              const canSetDefault =
                selectedEngine !== undefined &&
                !selectedEngine.isDefault &&
                engineChoices.length >= 2
              return (
                <>
                  {missingRecommended && dshAvailable && (
                    <div
                      className={css.hint}
                      data-opl-missing-default-hint={missingRecommended.harnessRef}
                    >
                      默认引擎 {missingRecommended.harnessName} 尚未安装，可一键安装或先使用内置 DSH
                      对话。
                    </div>
                  )}
                  <div className={css.pane}>
                    {availableEngines.length > 0 && (
                      <MenuGroup label="可用执行引擎">
                        {availableEngines.map((engine) => (
                          <button
                            key={engine.harnessRef}
                            ref={itemRef()}
                            type="button"
                            role="menuitemradio"
                            aria-checked={engine.isSelected}
                            className={`${css.option} ${engine.isSelected ? css.selected : ''}`}
                            disabled={busy}
                            onClick={() => void selectEngine(engine)}
                          >
                            <span className={css.optionCopy}>
                              <span className={css.optionRow}>
                                <span className={css.modelName}>{engine.harnessName}</span>
                                {engine.isDefault && <span className={css.badge}>默认</span>}
                                {!engine.isDefault && engine.isRecommended && (
                                  <span className={css.badge}>推荐</span>
                                )}
                                {engine.harnessRef === 'dsh' && (
                                  <span className={css.badge}>内置</span>
                                )}
                              </span>
                            </span>
                            <span className={css.check}>
                              {engine.isSelected ? <IconCheckOutlineRegular /> : null}
                            </span>
                          </button>
                        ))}
                      </MenuGroup>
                    )}
                    {unavailableEngines.length > 0 && (
                      <MenuGroup label="未安装引擎">
                        {unavailableEngines.map((engine) => (
                          <div
                            key={engine.harnessRef}
                            className={css.unavailableRow}
                            data-opl-unavailable-harness={engine.harnessRef}
                          >
                            <span className={css.optionCopy}>
                              <span className={css.optionRow}>
                                <span className={css.modelName}>{engine.harnessName}</span>
                                {engine.isRecommended && <span className={css.badge}>推荐</span>}
                              </span>
                              <span className={css.unavailableReason}>{engine.statusText}</span>
                            </span>
                            {engine.installable && (
                              <button
                                type="button"
                                className={css.installAction}
                                data-opl-install-harness={engine.harnessRef}
                                disabled={busy || engine.installing || !!installingHarness}
                                onClick={() => void installEngine(engine.harnessRef)}
                              >
                                {engine.installing ? '安装中…' : '一键安装'}
                              </button>
                            )}
                          </div>
                        ))}
                      </MenuGroup>
                    )}
                    {engineChoices.length === 0 && (
                      <div
                        className={css.empty}
                        role={loadingCatalog || !installationsLoaded ? 'status' : undefined}
                      >
                        {loadingCatalog || !installationsLoaded
                          ? loadingLabel
                          : '当前模型没有可用的执行引擎'}
                      </div>
                    )}
                    {canSetDefault && (
                      <div className={css.paneFooter}>
                        <button
                          type="button"
                          className={css.defaultAction}
                          data-opl-set-default-harness={selectedEngine.harnessRef}
                          disabled={busy}
                          onClick={() => void setDefaultEngine(selectedEngine)}
                        >
                          设为该模型默认
                        </button>
                      </div>
                    )}
                  </div>
                </>
              )
            })()
          ) : (
            <div className={`${css.groups} scrollable`}>
              {[...grouped].map(([source, choices]) => (
                <MenuGroup key={source} label={source}>
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
                </MenuGroup>
              ))}
              {paneChoices.length === 0 && (
                <div className={css.empty} role={loadingCatalog ? 'status' : undefined}>
                  {loadingCatalog ? loadingLabel : '当前没有可用的模型组合'}
                </div>
              )}
            </div>
          )}
        </>
      )}
      {renderPane === 'effort' && (
        <>
          {error && (
            <div className={css.error} role="alert">
              {error}
            </div>
          )}
          {effortChoices.length === 0 ? (
            <div className={css.empty}>
              {effortSwitch === undefined ? '当前模型未提供推理强度' : '当前模型未提供思考开关'}
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
    </>
  )

  if (inOfficialPane) {
    return (
      <div ref={menuRef} className={css.pane} onKeyDown={onKeyDown}>
        {menuBody}
      </div>
    )
  }

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
            {menuBody}
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

/**
 * Add the OPL combination entry to the official model menu.
 *
 * The official model selector owns the trigger and the model/reasoning panes;
 * this entry only opens the OPL-owned detail pane. Keeping this as a separate
 * component prevents OPL from shadowing official menu extensions such as Agent
 * Team.
 */
export function OfficialCombinationOption({
  locked,
  openPane,
  call,
  sessionId,
  available,
  selectionSource,
}: {
  locked: boolean
  openPane: (pane: { key: string; title: string }) => void
  call: Call
  sessionId: string
  available: boolean
  selectionSource?: SelectionSource | undefined
}) {
  const [catalog, setCatalog] = useState<ExecutionCatalog>()
  const [availability, setAvailability] = useState<HarnessCatalog['combinations']>([])
  const { selection } = useModelSelection({
    sessionId,
    available,
    selectionSource,
    onError: () => {},
    load: async (id: string) => {
      void call('catalog').then(setCatalog)
      void call('combinations', {}).then(setAvailability)
      const nextSelection = await call('model-selection', { sessionId: id })
      return nextSelection
    },
  })
  const currentChoices = useMemo(() => {
    if (!catalog || !selection.current) return []
    return catalog.combinations.filter(
      (combination) => combination.enabled && sameModel(combination.modelRef, selection.current),
    )
  }, [catalog, selection.current])
  const compatibleHarnessIds = useMemo(() => {
    if (!catalog || !selection.current) return []
    const pairing = catalog.supportedPairings?.find((item) =>
      sameModel(item.modelRef, selection.current),
    )
    return [
      ...new Set([...(pairing?.harnessRefs ?? []), ...currentChoices.map((c) => c.harnessRef)]),
    ]
  }, [catalog, currentChoices, selection.current])
  if (!available) return null
  // Keep the row mounted while the per-session selection and catalog are being
  // read. The official menu opens before those RPCs settle, and returning null
  // here made the OPL entry disappear permanently on a slow or cold session.
  const loading = catalog === undefined || selection.current === null
  if (!loading && compatibleHarnessIds.length === 0) return null
  if (loading) {
    return (
      <button
        type="button"
        role="menuitem"
        className={css.cell}
        data-model-menu-pane="opl-combinations"
        disabled={locked}
        onClick={() => openPane({ key: 'opl-combinations', title: '执行引擎' })}
      >
        <span className={css.cellLabel}>执行引擎</span>
        <span className={css.cellValue}>加载中…</span>
        <IconChevronRightOutlineRegular className={css.cellChevron} />
      </button>
    )
  }
  const currentSelection = selection.current
  if (!currentSelection) return null
  const isChoiceAvailable = (combinationId: string) =>
    availability.length === 0 ||
    availability.find((item) => item.id === combinationId)?.available === true
  const selected = currentChoices.find((choice) => choice.id === selection.combination)
  const selectedHarness = selected === undefined ? undefined : harnessFor(catalog, selected)
  const selectedAvailable = selected !== undefined && isChoiceAvailable(selected.id)
  const availableChoices = currentChoices.filter((choice) => isChoiceAvailable(choice.id))
  const onlyHarness =
    availableChoices.length === 1 ? harnessFor(catalog, availableChoices[0]) : undefined
  const recommendedId =
    officialHarnessFor(currentSelection) ??
    catalog.recommendations?.find((item) => sameModel(item.modelRef, currentSelection))?.harnessRef
  const recommendedHarness = recommendedId
    ? catalog.harnesses.find((item) => item.id === recommendedId)
    : undefined
  const recommendedChoice = recommendedId
    ? currentChoices.find((choice) => choice.harnessRef === recommendedId)
    : undefined
  const recommendedUnavailable =
    recommendedId !== undefined &&
    compatibleHarnessIds.includes(recommendedId) &&
    ((recommendedChoice !== undefined && !isChoiceAvailable(recommendedChoice.id)) ||
      (recommendedChoice === undefined && recommendedId !== 'dsh' && availableChoices.length === 0))
  const summaryLabel = selected
    ? selectedAvailable
      ? (selectedHarness?.name ?? selected.harnessRef)
      : `${selectedHarness?.name ?? selected.harnessRef}（未安装）`
    : onlyHarness
      ? onlyHarness.name
      : recommendedUnavailable
        ? `${recommendedHarness?.name ?? recommendedId}（未安装）`
        : availableChoices.length > 0
          ? '请选择'
          : (recommendedHarness?.name ?? '请选择')
  return (
    <button
      type="button"
      role="menuitem"
      className={css.cell}
      data-model-menu-pane="opl-combinations"
      disabled={locked}
      onClick={() => openPane({ key: 'opl-combinations', title: '执行引擎' })}
    >
      <span className={css.cellLabel}>执行引擎</span>
      <span className={css.cellValue}>{summaryLabel}</span>
      <IconChevronRightOutlineRegular className={css.cellChevron} />
    </button>
  )
}

/** The OPL combination selector rendered inside the official model-menu pane. */
export function OfficialCombinationPane({
  pendingCombination,
  call,
  sessionId,
  locked,
  dismiss,
  reportFailure,
  selectionSource,
  loadingLabel,
}: {
  pendingCombination?: PendingCombination
  call: Call
  sessionId: string
  locked: boolean
  dismiss: () => void
  reportFailure: (message: string) => void
  selectionSource?: SelectionSource | undefined
  loadingLabel: string
}) {
  return (
    <CombinationSelect
      {...(pendingCombination ? { pendingCombination } : {})}
      call={call}
      sessionId={sessionId}
      locked={locked}
      available
      selectionSource={selectionSource}
      loadingLabel={loadingLabel}
      variant="pane"
      officialControls={{ locked, dismiss, reportFailure }}
    />
  )
}
