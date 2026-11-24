import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ModelSelection as AgentModelSelection } from '@deepseek-ai/dsh-agent/types'
import type { ModelCatalog, ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { invokeHostRemote } from '../../compat/host/remote-invocation.ts'
import { withoutRememberingPermission } from '../../compat/host/permission-memory.ts'
import { modelDefaultEffort } from '../../shared/model-reasoning.ts'
import type { HarnessReasoningPreflight } from '../../contracts/types.ts'
import {
  executionModelRefKey,
  modelRefKey,
  type CombinationDefinition,
  type ModelRef,
} from '../contracts/catalog.ts'
import type { CodexGitBashRuntime } from '../contracts/codex-runtime.ts'
import type { HarnessSession } from '../contracts/sessions.ts'
import { adapterFor } from './adapters/index.ts'
import {
  antigravityWireModel,
  antigravityThinkingLevelsFor,
  ANTIGRAVITY_DEFAULT_THINKING,
} from './adapters/antigravity/models.ts'
import { stepLaneReasoning } from './adapters/step/step-models.ts'
import { MINIMAX_CODE_PROVIDER } from './adapters/minimax.ts'
import type { AdapterOptions } from './adapters/types.ts'
import type { ExecutionCatalog, ExecutionCatalogStore } from './catalog.ts'
import type { ExternalEffortStore } from './external-effort-store.ts'
import type { ExternalModelSources } from './model-sources.ts'
import { harnessProxyEnvironment } from './proxy.ts'
import {
  probeHarnessReasoning,
  readHarnessCurrentEffort,
  readHarnessReasoning,
} from './reasoning-preflight.ts'
import type { RuntimeMaintenance } from './runtime-maintenance.ts'
import { sameWorkingDirectory, asSessionId, now, required, type Active } from './harness-types.ts'

export interface HarnessSelectionHost {
  readonly ctx: Context
  readonly records: Map<string, HarnessSession>
  readonly active: Map<string, Active>
  readonly selections: Record<string, string>
  readonly externalEfforts: ExternalEffortStore
  readonly effortChanges: Map<string, symbol>
  readonly modelSources: ExternalModelSources
  readonly catalogStore: ExecutionCatalogStore
  readonly reasoningPreflights: Map<string, Promise<HarnessReasoningPreflight>>
  readonly runtimeMaintenance: RuntimeMaintenance
  readonly ready: Promise<void>
  readonly selectionsReady: Promise<void>
  readonly recordsReady: Promise<void>
  readonly disposed: boolean
  currentWorkingDirectory(session: Session): string
  ensureCurrentWorkingDirectory(session: Session): Promise<string>
  officialModelCatalog(): Promise<ModelCatalog>
  readonly catalogEpoch: number
  executionCatalog(options?: { fast?: boolean }): Promise<ExecutionCatalog>
  adapterOptions(
    command?: string,
    prefix?: string[],
    codexRuntime?: CodexGitBashRuntime,
  ): AdapterOptions
  conversationBinding(
    session: Session,
    definition: CombinationDefinition,
    cwd?: string,
  ): { cwd: string; sandbox: 'read-only' | 'workspace' | 'full-access'; taskId: string }
  bindSelection(sessionId: string, combination: string): Promise<void>
  runSelectionChange<T>(sessionId: string, operation: () => Promise<T>): Promise<T>
  native(method: string, request: object): Promise<unknown>
  assertMiniMaxCodeRouteEnabled(route: { harnessRef: string; modelRef: ModelRef }): void
  cliOwnsEffort(definition: CombinationDefinition): boolean
  normalizeConversationSelection(
    selection: ModelSelection,
    definition: CombinationDefinition | undefined,
    signal?: AbortSignal,
  ): Promise<AgentModelSelection>
  modelSelection(sessionId: string): Promise<Awaited<ReturnType<typeof modelSelection>>>
  reasoningPreflight(input: {
    sessionId: string
    combination: string
  }): Promise<HarnessReasoningPreflight>
  reasoningPreflightAdmitted(input: {
    sessionId: string
    combination: string
  }): Promise<HarnessReasoningPreflight>
  replacementFor(
    sessionId: string,
    catalog: ExecutionCatalog,
    ref: ModelRef,
  ): { record: HarnessSession; definition: CombinationDefinition } | undefined
  conversationEffort(
    sessionId: string,
    definition: CombinationDefinition,
    catalog: ExecutionCatalog,
  ): ReturnType<ExternalEffortStore['get']>
  combinationFor(
    sessionId: string,
    catalog: ExecutionCatalog,
    ref: { provider: string; model: string },
  ): CombinationDefinition | undefined
  unavailableConversationSelection(
    sessionId: string,
    catalog: ExecutionCatalog,
    ref: ModelRef,
  ): boolean
  selectionForModel(session: Session, selected: CombinationDefinition): Promise<ModelSelection>
}

/** CLI-advertised controls for third-party sources are not native provider effort IDs. */
export function cliOwnsEffort(
  definition: CombinationDefinition,
  modelSources: ExternalModelSources,
): boolean {
  return (
    definition.modelRef.provider !== MINIMAX_CODE_PROVIDER &&
    adapterFor(definition.harnessRef, definition.modelRef, modelSources)?.capabilities.reasoning ===
      'cli-advertised'
  )
}

export async function normalizeConversationSelection(
  host: HarnessSelectionHost,
  selection: ModelSelection,
  definition: CombinationDefinition | undefined,
  signal?: AbortSignal,
): Promise<AgentModelSelection> {
  const ref = { provider: selection.provider, model: selection.model }
  const adapter = definition && adapterFor(definition.harnessRef, ref, host.modelSources)
  if (definition && (host.cliOwnsEffort(definition) || adapter?.capabilities.reasoning === 'none'))
    return ref
  if (selection.reasoningEffort !== undefined)
    return { ...ref, reasoningEffort: ReasoningEffortId(selection.reasoningEffort) }
  if (
    ref.model.split('::').at(-1) === 'deepseek-flash' ||
    ref.model.split('::').at(-1)?.startsWith('gpt-')
  ) {
    const info = await host.ctx.llm.resolveModelInfo(ref.provider, ref.model, signal)
    const effort = modelDefaultEffort(ref.model, info.reasoning)
    if (effort !== undefined) return { ...ref, reasoningEffort: ReasoningEffortId(effort) }
  }
  return ref
}

export async function modelSelection(host: HarnessSelectionHost, sessionId: string) {
  // Session history can contain many external records and is loaded from disk
  // independently. The picker only needs the selection file, the official
  // projection and the persisted catalog, so do not hold its first paint on
  // history recovery. A loaded historical record remains an optional fallback.
  await host.selectionsReady
  const session = host.ctx.sessions.get(asSessionId<SessionId>(required(sessionId, 'sessionId')))
  const [catalog, executionCatalog] = await Promise.all([
    host.officialModelCatalog(),
    host.executionCatalog({ fast: true }),
  ])
  const cold = session
    ? null
    : ((await invokeHostRemote(host.ctx, {
        namespace: 'session',
        method: 'projections',
        args: { request: { sessionId } },
      })) as import('@deepseek-ai/dsh-api-session-controller/types').SessionProjectionsValue)
  const projection = session
    ? host.ctx.sessionProjections.snapshot(session, ['modelSelection']).values.modelSelection
    : cold?.kind === 'sequenced'
      ? cold.values.modelSelection
      : undefined
  const bound = executionCatalog.combinations.find(
    (item) => item.enabled && item.id === host.selections[sessionId],
  )
  // Official live/cold projections own the model choice. OPL references are
  // only a fallback for records without an exact official selection yet.
  const historical = [...host.records.values()].find(
    (record) =>
      record.nativeSessionId === sessionId && record.combination === host.selections[sessionId],
  )
  const current: ModelSelection =
    projection?.next ??
    projection?.lastUsed ??
    bound?.modelRef ??
    historical?.modelRef ??
    catalog.default
  const selected = host.combinationFor(sessionId, executionCatalog, current)
  const adapter = selected && adapterFor(selected.harnessRef, selected.modelRef, host.modelSources)
  const groups =
    adapter?.capabilities.reasoning === 'none'
      ? catalog.groups.map((group) => ({
          ...group,
          models: group.models.map((model) => {
            if (group.id !== current.provider || model.id !== current.model) return model
            const { reasoning: _, ...cliModel } = model
            return cliModel
          }),
        }))
      : catalog.groups
  const choice =
    selected && host.cliOwnsEffort(selected)
      ? host.conversationEffort(sessionId, selected, executionCatalog)
      : undefined
  const nativeReasoning = catalog.groups
    .find((group) => group.id === current.provider)
    ?.models.find((model) => model.id === current.model)?.reasoning
  const { reasoningEffort: _providerEffort, ...ref } = current as ModelSelection
  const harnessOwnsEffort =
    !!selected && (host.cliOwnsEffort(selected) || adapter?.capabilities.reasoning === 'none')
  const explicitEffort =
    current.reasoningEffort === 'default' &&
    !nativeReasoning?.efforts.some((effort) => effort.id === 'default')
      ? undefined
      : current.reasoningEffort
  const inferredEffort = explicitEffort ?? modelDefaultEffort(current.model, nativeReasoning)
  const normalizedCurrent =
    inferredEffort === undefined
      ? ref
      : { ...ref, reasoningEffort: ReasoningEffortId(inferredEffort) }
  const displayed = harnessOwnsEffort
    ? { ...ref, ...(choice ? { reasoningEffort: choice } : {}) }
    : normalizedCurrent
  const gatewayGemini =
    selected?.harnessRef === 'antigravity' && antigravityWireModel(selected.modelRef)
  return {
    ...(gatewayGemini
      ? {
          registeredEfforts: {
            levels: [...antigravityThinkingLevelsFor(gatewayGemini)],
            defaultEffort: ANTIGRAVITY_DEFAULT_THINKING,
            revision: host.catalogEpoch,
          },
        }
      : {}),
    current: displayed,
    groups,
    ...(selected ? { combination: selected.id } : {}),
    ...(harnessOwnsEffort ? { effortSource: 'harness' as const } : {}),
  }
}

export async function selectEffort(
  host: HarnessSelectionHost,
  input: ModelSelection & { sessionId: string },
): Promise<unknown> {
  await host.ready
  const session = host.ctx.sessions.get(asSessionId<SessionId>(input.sessionId))
  if (!session) throw Error('对话不存在')
  const rawSelection = () => {
    const projection = host.ctx.sessionProjections.snapshot(session, ['modelSelection']).values
      .modelSelection
    return projection?.next ?? projection?.lastUsed
  }
  const initial = rawSelection()
  const selectionBinding = host.selections[input.sessionId]
  const selected = await host.modelSelection(input.sessionId)
  if (modelRefKey(selected.current) !== modelRefKey(input))
    throw Error('模型选择已改变，请重新选择推理档位')
  const definition = (await host.executionCatalog()).combinations.find(
    (c) => c.id === selected.combination,
  )
  if (
    definition &&
    adapterFor(definition.harnessRef, definition.modelRef, host.modelSources)?.capabilities
      .reasoning === 'none' &&
    input.reasoningEffort !== undefined
  )
    throw Error('当前 Harness 未提供推理档位，请重新选择')
  if (!definition || !host.cliOwnsEffort(definition)) {
    const { sessionId, ...request } = input
    const normalized = await host.normalizeConversationSelection(request, definition)
    const current = rawSelection()
    if (
      host.disposed ||
      host.selections[input.sessionId] !== selectionBinding ||
      current?.reasoningEffort !== initial?.reasoningEffort ||
      (current && modelRefKey(current) !== modelRefKey(input))
    )
      throw Error('模型选择已改变，请重新选择推理档位')
    return host.native('selectModel', { sessionId, ...normalized })
  }
  const token = Symbol()
  host.effortChanges.set(input.sessionId, token)
  const binding = host.selections[input.sessionId]
  const current = () => {
    if (
      host.disposed ||
      host.effortChanges.get(input.sessionId) !== token ||
      host.selections[input.sessionId] !== binding ||
      host.ctx.agents.get(asSessionId<SessionId>(input.sessionId))?.status === 'running'
    )
      throw Error('会话状态已改变，请重新选择推理档位')
    const projection = host.ctx.sessionProjections.snapshot(session, ['modelSelection']).values
      .modelSelection
    const ref = projection?.next ?? projection?.lastUsed
    if (ref && modelRefKey(ref) !== modelRefKey(input))
      throw Error('模型选择已改变，请重新选择推理档位')
  }
  current()
  if (input.reasoningEffort !== undefined) {
    const advertised = await host.reasoningPreflight({
      sessionId: input.sessionId,
      combination: definition.id,
    })
    current()
    if (
      advertised.status !== 'known' ||
      !advertised.efforts.some((e) => e.id === input.reasoningEffort)
    )
      throw Error('当前 Harness 未提供所选推理档位，请重新选择')
  }
  // Clear any previous native effort while leaving provider defaults to its controller.
  await host.native('selectModel', {
    sessionId: input.sessionId,
    provider: input.provider,
    model: input.model,
  })
  current()
  await host.externalEfforts.set(input.sessionId, definition.id, input.reasoningEffort, current)
  return { selected: (await host.modelSelection(input.sessionId)).current }
}

export async function reasoningPreflight(
  host: HarnessSelectionHost,
  input: { sessionId: string; combination: string },
): Promise<HarnessReasoningPreflight> {
  await host.ready
  const session = host.ctx.sessions.get(asSessionId<SessionId>(input.sessionId))
  const projected = session
    ? host.ctx.sessionProjections.snapshot(session, ['modelSelection']).values.modelSelection
    : undefined
  const key = JSON.stringify([
    input.sessionId,
    input.combination,
    host.externalEfforts.get(input.sessionId, input.combination),
    (projected?.next ?? projected?.lastUsed)?.reasoningEffort,
  ])
  const existing = host.reasoningPreflights.get(key)
  if (existing) return existing
  const pending = host.runtimeMaintenance
    .admit(() => host.reasoningPreflightAdmitted(input))
    .finally(() => host.reasoningPreflights.delete(key))
  host.reasoningPreflights.set(key, pending)
  return pending
}

export async function reasoningPreflightAdmitted(
  host: HarnessSelectionHost,
  input: { sessionId: string; combination: string },
): Promise<HarnessReasoningPreflight> {
  const session = host.ctx.sessions.get(
    asSessionId<SessionId>(required(input.sessionId, 'sessionId')),
  )
  if (!session) throw Error('对话不存在')
  const catalog = await host.executionCatalog()
  const definition = catalog.combinations.find(
    (item) => item.id === input.combination && item.enabled,
  )
  if (!definition || definition.harnessRef === 'dsh')
    return { status: 'not-applicable', efforts: [] }
  const adapter = adapterFor(definition.harnessRef, definition.modelRef, host.modelSources)
  if (!adapter || adapter.capabilities.reasoning === 'none')
    return { status: 'not-applicable', efforts: [] }
  if (definition.harnessRef === 'step-code' && stepLaneReasoning(definition.modelRef) === false)
    return { status: 'known', efforts: [] }
  if (
    ['codex', 'claude'].includes(definition.harnessRef) ||
    definition.modelRef.provider === MINIMAX_CODE_PROVIDER
  ) {
    const nativeCatalog = (await invokeHostRemote(host.ctx, {
      namespace: 'session',
      method: 'modelCatalog',
      args: {},
    })) as ModelCatalog
    const reasoning = nativeCatalog.groups
      .find((group) => group.id === definition.modelRef.provider)
      ?.models.find((model) => model.id === definition.modelRef.model)?.reasoning
    const selection = await host.modelSelection(session.id)
    const currentEffort =
      selection.current.provider === definition.modelRef.provider &&
      selection.current.model === definition.modelRef.model
        ? ((selection.current as ModelSelection).reasoningEffort ??
          modelDefaultEffort(definition.modelRef.model, reasoning))
        : undefined
    return {
      status: 'known',
      efforts: reasoning ? [...reasoning.efforts] : [],
      ...(currentEffort && reasoning?.efforts.some((effort) => effort.id === currentEffort)
        ? { currentEffort }
        : {}),
    }
  }
  if (adapter.capabilities.reasoning === 'model-declared') return { status: 'known', efforts: [] }
  const replacement = host.replacementFor(session.id, catalog, definition.modelRef)
  const bound =
    [...host.records.values()].find(
      (record) => record.nativeSessionId === session.id && record.combination === definition.id,
    ) ?? (replacement?.definition.id === definition.id ? replacement.record : undefined)
  const requestedEffort =
    (host.cliOwnsEffort(definition)
      ? host.conversationEffort(session.id, definition, catalog)
      : ((await host.modelSelection(session.id)).current as ModelSelection).reasoningEffort) ??
    undefined
  const boundActive = bound ? host.active.get(bound.id) : undefined
  if (
    boundActive?.acp &&
    !boundActive.acp.closed &&
    boundActive.configOptions !== undefined &&
    bound?.reasoningEffort === requestedEffort
  ) {
    const efforts = readHarnessReasoning(bound!, boundActive.configOptions)
    const currentEffort = readHarnessCurrentEffort(bound!, boundActive.configOptions)
    return efforts === undefined
      ? { status: 'unavailable', efforts: [] }
      : { status: 'known', efforts, ...(currentEffort ? { currentEffort } : {}) }
  }
  if (host.ctx.agents.get(session.id)?.status === 'running')
    return { status: 'unavailable', efforts: [] }
  const cwd = await host.ensureCurrentWorkingDirectory(session)
  if (bound && !sameWorkingDirectory(bound.cwd, cwd)) return { status: 'unavailable', efforts: [] }
  const binding = host.conversationBinding(session, definition, cwd)
  const harness = catalog.harnesses.find((item) => item.id === definition.harnessRef)
  const record: HarnessSession = {
    id: 'reasoning-preflight-' + randomUUID(),
    combination: definition.id,
    harnessRef: definition.harnessRef,
    modelRef: definition.modelRef,
    ...(requestedEffort === undefined ? {} : { reasoningEffort: requestedEffort }),
    cwd: binding.cwd,
    origin: { kind: 'dsh', sessionId: session.id },
    sandbox: binding.sandbox,
    acpSessionId: '',
    title: definition.name,
    createdAt: now(),
    updatedAt: now(),
    turns: [],
  }
  try {
    const launch = await adapter.prepare!(
      host.ctx,
      record,
      host.adapterOptions(harness?.command, harness?.prefix, harness?.codexRuntime),
    )
    if (host.disposed) return { status: 'unavailable', efforts: [] }
    const result = await probeHarnessReasoning(adapter, record, {
      ...launch,
      env: harnessProxyEnvironment(launch.env, harness?.proxy),
    })
    const afterCwd = host.currentWorkingDirectory(session)
    if (
      host.disposed ||
      !sameWorkingDirectory(afterCwd, cwd) ||
      host.conversationBinding(session, definition, afterCwd).sandbox !== binding.sandbox
    )
      return { status: 'unavailable', efforts: [] }
    return result
  } catch {
    return { status: 'unavailable', efforts: [] }
  }
}

/** Resolve a retired ID only through one saved conversation and one identical live route. */
export function replacementFor(
  host: HarnessSelectionHost,
  sessionId: string,
  catalog: ExecutionCatalog,
  ref: ModelRef,
): { record: HarnessSession; definition: CombinationDefinition } | undefined {
  const selectedId = host.selections[sessionId]
  if (!selectedId || catalog.combinations.some((item) => item.id === selectedId)) return undefined
  const records = [...host.records.values()].filter(
    (record) =>
      record.nativeSessionId === sessionId &&
      record.combination === selectedId &&
      executionModelRefKey(record.modelRef) === executionModelRefKey(ref),
  )
  if (records.length !== 1) return undefined
  const record = records[0]!
  const candidates = catalog.combinations.filter(
    (item) =>
      item.enabled &&
      item.harnessRef === record.harnessRef &&
      executionModelRefKey(item.modelRef) === executionModelRefKey(record.modelRef),
  )
  return candidates.length === 1 ? { record, definition: candidates[0]! } : undefined
}

/** Preserve the retired combination's effort until the user sets a choice on its replacement. */
export function conversationEffort(
  host: HarnessSelectionHost,
  sessionId: string,
  definition: CombinationDefinition,
  catalog: ExecutionCatalog,
) {
  const selected = host.externalEfforts.get(sessionId, definition.id)
  if (selected !== undefined) return selected
  const replacement = host.replacementFor(sessionId, catalog, definition.modelRef)
  return replacement?.definition.id === definition.id
    ? host.externalEfforts.get(sessionId, replacement.record.combination)
    : undefined
}

export function combinationFor(
  host: HarnessSelectionHost,
  sessionId: string,
  catalog: ExecutionCatalog,
  ref: { provider: string; model: string },
): CombinationDefinition | undefined {
  const exact = catalog.combinations.find(
    (item) =>
      item.enabled &&
      item.id === host.selections[sessionId] &&
      executionModelRefKey(item.modelRef) === executionModelRefKey(ref),
  )
  if (exact) return exact
  const replacement = host.replacementFor(sessionId, catalog, ref)
  if (replacement) return replacement.definition
  if (host.unavailableConversationSelection(sessionId, catalog, ref)) return undefined
  const candidates = catalog.combinations.filter(
    (item) => item.enabled && executionModelRefKey(item.modelRef) === executionModelRefKey(ref),
  )
  const defaults = candidates.filter((item) => item.isDefault)
  if (defaults.length === 1) return defaults[0]
  return candidates.length === 1 ? candidates[0] : undefined
}

export function unavailableConversationSelection(
  host: HarnessSelectionHost,
  sessionId: string,
  catalog: ExecutionCatalog,
  ref: ModelRef,
): boolean {
  const selectedId = host.selections[sessionId]
  if (!selectedId) return false
  const selected = catalog.combinations.find((item) => item.id === selectedId)
  const model = executionModelRefKey(ref)
  if (selected) return !selected.enabled && executionModelRefKey(selected.modelRef) === model
  const history = [...host.records.values()].filter(
    (record) => record.nativeSessionId === sessionId && record.combination === selectedId,
  )
  // A selected combination has an ID before its first send creates any Harness record.
  // With no record of its model, an explicit reselection is required before routing.
  return (
    history.length === 0 ||
    history.some((record) => executionModelRefKey(record.modelRef) === model)
  )
}

export async function selectionForModel(
  host: HarnessSelectionHost,
  session: Session,
  selected: CombinationDefinition,
): Promise<ModelSelection> {
  const ref = selected.modelRef
  const adapter = adapterFor(selected.harnessRef, ref, host.modelSources)
  if (host.cliOwnsEffort(selected)) return ref
  if (adapter?.capabilities.reasoning === 'none') return ref
  const catalog = (await invokeHostRemote(host.ctx, {
    namespace: 'session',
    method: 'modelCatalog',
    args: {},
  })) as ModelCatalog
  const reasoning = catalog.groups
    .find((group) => group.id === ref.provider)
    ?.models.find((model) => model.id === ref.model)?.reasoning
  const projection = host.ctx.sessionProjections.snapshot(session, ['modelSelection']).values
    .modelSelection
  const current = projection?.next ?? projection?.lastUsed
  const matches = (selection: ModelSelection) =>
    executionModelRefKey(selection) === executionModelRefKey(ref)
  const sameCurrentModel = current !== undefined && current !== null && matches(current)
  const event = sameCurrentModel
    ? undefined
    : session
        .snapshotEvents()
        .findLast((event) => event.type === 'model/selection' && matches(event.data))
  const previous = sameCurrentModel
    ? current
    : event?.type === 'model/selection'
      ? event.data
      : matches(catalog.default)
        ? catalog.default
        : undefined
  const effort = previous?.reasoningEffort
  const supported = effort !== undefined && reasoning?.efforts.some((item) => item.id === effort)
  // External ACP CLIs advertise their own effort vocabulary at session setup.
  // Do not invent a suite default before that advertisement exists: Poolside
  // may expose no thought_level at all, and a model such as Kimi K3 may omit
  // `high`. The adapter will still reject an explicitly selected stale value.
  const reasoningEffort =
    supported || adapter?.capabilities.reasoning !== 'cli-advertised'
      ? supported
        ? effort
        : modelDefaultEffort(ref.model, reasoning)
      : undefined
  return { ...ref, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
}

export async function selectCombination(
  host: HarnessSelectionHost,
  input: { sessionId: string; combination: string },
) {
  const sessionId = required(input.sessionId, 'sessionId')
  return host.runSelectionChange(sessionId, async () => {
    await host.ready
    const session = host.ctx.sessions.get(asSessionId<SessionId>(sessionId))
    if (!session) throw Error('对话不存在')
    if (host.ctx.agents.get(session.id)?.status === 'running')
      throw Error('请等待当前轮次结束后切换组合')
    const catalog = await host.executionCatalog(),
      definition = catalog.combinations.find(
        (item) => item.id === input.combination && item.enabled,
      )
    if (!definition) throw Error('组合不存在或已停用')
    const model = catalog.models.find(
      (item) => modelRefKey(item.ref) === modelRefKey(definition.modelRef),
    )
    if (!model?.available) throw Error(model?.reason ?? '模型未配置或凭据未就绪')
    const harness = catalog.harnesses.find((item) => item.id === definition.harnessRef)
    const adapter = adapterFor(definition.harnessRef, definition.modelRef, host.modelSources)
    if (!harness || !adapter) throw Error('组合没有兼容适配器')
    const available = await adapter.available(
      host.ctx,
      host.adapterOptions(harness.command, harness.prefix, harness?.codexRuntime),
    )
    if (!available.available) throw Error(available.reason ?? 'Harness 未就绪')
    const selection = await host.selectionForModel(session, definition)
    if (definition.harnessRef === 'dsh') {
      await host.native('selectModel', { sessionId: session.id, ...selection })
      await host.bindSelection(session.id, definition.id)
      return { kind: 'native', sessionId: session.id }
    }
    await host.native('selectModel', {
      sessionId: session.id,
      ...selection,
    })
    await host.bindSelection(session.id, definition.id)
    return { kind: 'external', sessionId: session.id }
  })
}

export async function bindRoleCombination(
  host: HarnessSelectionHost,
  agent: Agent,
  combination: string,
): Promise<void> {
  await host.ready
  if (host.selections[agent.id]) return
  if (agent.session.snapshotEvents().some((event) => event.type === 'turn/start')) return
  const catalog = await host.executionCatalog()
  const definition = catalog.combinations.find((item) => item.id === combination && item.enabled)
  if (!definition) throw Error('角色执行组合不存在或已停用')
  if (!['dsh', 'codex', 'claude'].includes(definition.harnessRef))
    throw Error('角色团队当前支持 DSH、Codex 和 Claude Code')
  const model = catalog.models.find(
    (item) => modelRefKey(item.ref) === modelRefKey(definition.modelRef),
  )
  if (!model?.available) throw Error(model?.reason ?? '角色使用的模型尚未就绪')
  if (definition.permissionPolicy === 'read-only' && !definition.generated)
    withoutRememberingPermission(agent.session, () =>
      host.ctx.permissionPresets.set(agent.session, 'read-only'),
    )
  agent.model.select(await host.normalizeConversationSelection(definition.modelRef, definition))
  await host.bindSelection(agent.id, definition.id)
}

export async function assertMiniMaxNativeSelectionEnabled(
  host: HarnessSelectionHost,
  sessionId: string,
): Promise<void> {
  const selectedId = host.selections[sessionId]
  if (!selectedId) return
  const selected = (await host.catalogStore.get()).combinations.find(
    (item) => item.id === selectedId,
  )
  if (selected) host.assertMiniMaxCodeRouteEnabled(selected)
}
