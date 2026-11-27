import { useCallback, useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { GatewayGroupStatus } from '../contracts/account.ts'
import { gatewayModelChoices } from '../shared/model-choices.ts'
import { splitProxyHint, summarizeDiscoveryErrors } from './discovery-errors.ts'
import { displayModelName, gatewayChoiceKey } from '../../shared/models.ts'
import type { GatewayModelSettings, ModelDraft } from '../contracts/models.ts'
import css from '../../shared/client/SettingsSection.module.css'
import type { GatewayCall as Call } from '../../shared/client/remote-call.ts'

const DISCOVERY_CONCURRENCY = 2

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []
  const results = new Array<R>(items.length)
  let next = 0
  const run = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await worker(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
  return results
}

function ErrorSummary({
  summary,
  role,
}: {
  summary: ReturnType<typeof summarizeDiscoveryErrors>
  role: 'alert' | 'status'
}) {
  if (!summary.items.length) return null
  return (
    <div role={role} className={`${css.error} ${css.errorList}`}>
      {summary.items.map((item, index) => (
        <p key={`${index}:${item}`}>{item}</p>
      ))}
      {summary.hints.map((hint) => (
        <p key={hint} className={css.muted}>
          {hint}
        </p>
      ))}
      {summary.suffix && <p>{summary.suffix}</p>}
    </div>
  )
}

export interface GatewayModelsProps {
  call: Call
  groups?: readonly GatewayGroupStatus[]
  onToggleGroup?: (id: string, enabled: boolean) => Promise<void>
  accountBusy?: boolean
}

/** Unified Gateway model & group panel rendered inside the OPL Gateway settings page. */
export function GatewayModels({
  call,
  groups,
  onToggleGroup,
  accountBusy = false,
}: GatewayModelsProps) {
  const [data, setData] = useState<GatewayModelSettings>()
  const [error, setError] = useState(''),
    [discoveryFailure, setDiscoveryFailure] = useState<{
      groups: Set<string>
      summary: ReturnType<typeof summarizeDiscoveryErrors>
    } | null>(null),
    [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [activeTab, setActiveTab] = useState('all')
  const [manualGroup, setManualGroup] = useState('')
  const [candidates, setCandidates] = useState<{ group: string; model: ModelDraft }[]>()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [selectedGroup, setSelectedGroup] = useState('deepseek')

  const reload = useCallback(async () => {
    const value = await call('read')
    setData(value)
    return value
  }, [call])

  useEffect(() => {
    let live = true
    void call('read')
      .then((value) => {
        if (live) setData(value)
      })
      .catch(() => {
        if (live) setError('无法读取模型配置')
      })
    return () => {
      live = false
    }
  }, [call])

  const act = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError('')
    setDiscoveryFailure(null)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  const change = (id: string, patch: Partial<GatewayModelSettings['groups'][number]>) =>
    setData(
      (current) =>
        current && {
          groups: current.groups.map((group) => (group.id === id ? { ...group, ...patch } : group)),
        },
    )

  const ref = (group: string, id: string) => (group === 'deepseek' ? id : group + '::' + id)
  const label = (group: string, model: ModelDraft) =>
    displayModelName({ provider: 'opl-gateway', model: ref(group, model.id) }, model.name)

  const models = new Map<string, { group: string; model: ModelDraft }>()
  for (const group of data?.groups ?? [])
    if (group.ready)
      for (const model of group.models) {
        if (activeTab !== 'all' && group.id !== activeTab) continue
        const key = gatewayChoiceKey(ref(group.id, model.id))
        if (!models.has(key)) models.set(key, { group: group.id, model })
      }
  const grouped = (entries: { group: string; model: ModelDraft }[]) => [
    ...Map.groupBy(entries, (item) => item.model.id),
  ]
  const baseLabel = (model: ModelDraft) =>
    displayModelName({ provider: 'catalog', model: model.id }, model.name)

  const persistentDiagnostics = data
    ? summarizeDiscoveryErrors(
        data.groups
          .filter(
            (group) =>
              group.enabled !== false &&
              (activeTab === 'all' || group.id === activeTab) &&
              group.catalog?.diagnostic &&
              !discoveryFailure?.groups.has(group.id),
          )
          .map((group) => `${group.name}：${group.catalog!.diagnostic!.message}`),
      )
    : undefined
  const activeHintSet = new Set(discoveryFailure?.summary.hints ?? [])
  const filteredPersistentDiagnostics = persistentDiagnostics
    ? {
        ...persistentDiagnostics,
        hints: persistentDiagnostics.hints.filter((hint) => !activeHintSet.has(hint)),
      }
    : undefined

  const activeGroupEntry =
    activeTab === 'all' ? undefined : data?.groups.find((group) => group.id === activeTab)
  const activeAccountGroup =
    activeTab === 'all' ? undefined : groups?.find((group) => group.id === activeTab)
  const selectedGroupEntry = data?.groups.find((group) => group.id === selectedGroup)
  const selectedGroupDiscoveryFailed =
    discoveryFailure?.groups.has(selectedGroup) === true ||
    selectedGroupEntry?.catalog?.state === 'error'

  const editableGroups =
    data?.groups.filter(
      (group) => group.enabled !== false && (group.ready || group.models.length > 0),
    ) ?? []
  const resolvedEditableGroups = editableGroups.length ? editableGroups : (data?.groups ?? [])
  const activeManualGroup =
    resolvedEditableGroups.find((g) => g.id === manualGroup) ??
    (activeTab !== 'all' ? resolvedEditableGroups.find((g) => g.id === activeTab) : undefined) ??
    resolvedEditableGroups[0]

  const isDisabled = busy || accountBusy

  return (
    <div
      className={css.detailsBody}
      data-opl-panel="gateway-models"
      aria-busy={busy || accountBusy || (!data && !error)}
    >
      {error && (
        <p role="alert" className={css.error}>
          {error}
        </p>
      )}
      {discoveryFailure && <ErrorSummary summary={discoveryFailure.summary} role="alert" />}
      {!data && !error && (
        <p role="status" className={css.muted}>
          正在加载模型…
        </p>
      )}
      {data && (
        <>
          <div className={css.header}>
            <div>
              <h3>模型与分组</h3>
              <p className={css.muted}>
                {grouped([...models.values()]).length} 个可用模型 · 登录后自动同步并随分组凭据切换
              </p>
            </div>
            <button
              type="button"
              className={css.providerAction}
              disabled={isDisabled}
              onClick={() =>
                void act(async () => {
                  const available: { group: string; model: ModelDraft }[] = []
                  const failures: string[] = []
                  const failedGroups = new Set<string>()
                  const readyGroups = data.groups.filter((g) => g.ready)
                  const results = await mapWithConcurrency(
                    readyGroups,
                    DISCOVERY_CONCURRENCY,
                    async (group) => {
                      try {
                        const fetched = await call('discover', { group: group.id })
                        return {
                          group,
                          models: gatewayModelChoices(fetched, group.models),
                          failure: undefined,
                        }
                      } catch (err) {
                        return {
                          group,
                          models: group.models,
                          failure:
                            err instanceof Error
                              ? err.message.trim()
                              : `${group.name}：目录获取失败。`,
                        }
                      }
                    },
                  )
                  for (const result of results) {
                    available.push(
                      ...result.models.map((model) => ({ group: result.group.id, model })),
                    )
                    if (result.failure) {
                      failures.push(result.failure)
                      failedGroups.add(result.group.id)
                    }
                  }
                  const latest = await call('read').catch(() => undefined)
                  if (latest) {
                    setData((current) =>
                      !editing || !current
                        ? latest
                        : {
                            groups: current.groups.map((existing) => {
                              const next = latest.groups.find((item) => item.id === existing.id)
                              return next
                                ? {
                                    ...next,
                                    models: existing.models,
                                    api: existing.api,
                                  }
                                : existing
                            }),
                          },
                    )
                  } else {
                    setData(
                      (current) =>
                        current && {
                          groups: current.groups.map((existing) => {
                            const matched = results.find((item) => item.group.id === existing.id)
                            if (!matched || matched.failure) return existing
                            return {
                              ...existing,
                              catalog: matched.models.length
                                ? { state: 'ready', count: matched.models.length }
                                : { state: 'empty', count: 0 },
                            }
                          }),
                        },
                    )
                  }
                  setCandidates(available)
                  const initialSelection =
                    activeTab !== 'all' && readyGroups.some((g) => g.id === activeTab)
                      ? activeTab
                      : (readyGroups[0]?.id ?? '')
                  setSelectedGroup(initialSelection)
                  setSelected(
                    new Set(data.groups.flatMap((g) => g.models.map((m) => ref(g.id, m.id)))),
                  )
                  if (failures.length) {
                    setDiscoveryFailure({
                      groups: failedGroups,
                      summary: summarizeDiscoveryErrors(failures, '已保留当前已配置模型。'),
                    })
                  }
                })
              }
            >
              {busy ? '正在获取…' : '选择模型'}
            </button>
          </div>

          {data.groups.length > 0 && (
            <div className={css.tabRow} role="tablist" aria-label="模型分组过滤">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'all'}
                className={`${css.tab} ${activeTab === 'all' ? css.tabActive : ''}`}
                disabled={isDisabled}
                onClick={() => setActiveTab('all')}
              >
                全部
              </button>
              {data.groups.map((group) => (
                <button
                  key={group.id}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === group.id}
                  className={`${css.tab} ${activeTab === group.id ? css.tabActive : ''}`}
                  disabled={isDisabled}
                  onClick={() => {
                    setActiveTab(group.id)
                    if (candidates && group.ready) setSelectedGroup(group.id)
                  }}
                >
                  {group.name}
                  {group.rateMultiplier !== undefined ? ` ${group.rateMultiplier}×` : ''}
                </button>
              ))}
            </div>
          )}

          {activeGroupEntry && (
            <div className={css.gatewayGroupBar}>
              <div>
                <strong>{activeGroupEntry.name}</strong>
                <p className={css.muted}>
                  {activeAccountGroup?.authorized === false ||
                  activeGroupEntry.state === 'unauthorized'
                    ? '账号未开放'
                    : activeGroupEntry.enabled !== false && activeGroupEntry.state === 'ready'
                      ? '账号可用 · 凭据已同步'
                      : activeAccountGroup?.authorized === true
                        ? '账号可用'
                        : '权限待刷新'}
                  {activeGroupEntry.rateMultiplier !== undefined
                    ? ` · 分组倍率 ${activeGroupEntry.rateMultiplier}×`
                    : ''}
                </p>
                {activeAccountGroup?.error && activeGroupEntry.state === 'error' && (
                  <p className={css.error}>{activeAccountGroup.error}</p>
                )}
              </div>
              {onToggleGroup && (
                <label className={css.switchControl}>
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label={`在此 DSH 激活 ${activeGroupEntry.name}`}
                    checked={activeGroupEntry.enabled !== false}
                    disabled={
                      isDisabled ||
                      activeAccountGroup?.authorized === false ||
                      activeGroupEntry.state === 'unauthorized'
                    }
                    onChange={(event) => {
                      const enabled = event.target.checked
                      void act(async () => {
                        await onToggleGroup(activeGroupEntry.id, enabled)
                        await reload().catch(() => undefined)
                      })
                    }}
                  />
                  {activeGroupEntry.enabled !== false ? '已激活' : '未激活'}
                </label>
              )}
            </div>
          )}

          {filteredPersistentDiagnostics && (
            <ErrorSummary summary={filteredPersistentDiagnostics} role="status" />
          )}

          <div className={css.modelRows}>
            {grouped([...models.values()]).map(([id, channels]) => (
              <div className={css.modelRow} key={id}>
                <div>
                  <span>{baseLabel(channels[0]!.model)}</span>
                  {channels.length > 1 && (
                    <p className={css.muted}>
                      {channels
                        .map((item) => data.groups.find((g) => g.id === item.group)?.name)
                        .join(' / ')}
                    </p>
                  )}
                </div>
                <span className={css.muted}>
                  {channels.length > 1 ? `${channels.length} 个渠道` : '已配置'}
                </span>
              </div>
            ))}
          </div>

          {!models.size && (
            <p className={css.muted}>
              {data.groups.some((group) => group.ready)
                ? '当前筛选下暂无模型。可点击“选择模型”或展开下方手动配置。'
                : '请先激活至少一个可用分组以使用模型。'}
            </p>
          )}

          {candidates && (
            <div className={css.editor}>
              <label className={css.field}>
                <span>分组</span>
                <select
                  className={css.input}
                  value={selectedGroup}
                  disabled={isDisabled}
                  onChange={(e) => setSelectedGroup(e.target.value)}
                >
                  {data.groups
                    .filter((g) => g.ready)
                    .map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.name}
                      </option>
                    ))}
                </select>
              </label>
              <p className={css.muted}>勾选此分组中需要使用的模型。</p>
              {selectedGroupDiscoveryFailed && (
                <p className={css.muted}>此分组目录获取失败，当前仅列出已保留的已配置模型。</p>
              )}
              <div className={css.modelRows}>
                {candidates
                  .filter((item) => item.group === selectedGroup)
                  .map(({ group, model }) => {
                    const key = ref(group, model.id)
                    return (
                      <label className={css.modelRow} key={key}>
                        <span>{baseLabel(model)}</span>
                        <input
                          type="checkbox"
                          aria-label={label(group, model)}
                          disabled={isDisabled}
                          checked={selected.has(key)}
                          onChange={(e) =>
                            setSelected((current) => {
                              const next = new Set(current)
                              e.target.checked ? next.add(key) : next.delete(key)
                              return next
                            })
                          }
                        />
                      </label>
                    )
                  })}
              </div>
              {!candidates.some((item) => item.group === selectedGroup) && (
                <p className={css.muted}>此分组未返回模型，可刷新目录或使用下方手动配置。</p>
              )}
              <div className={css.actions}>
                <Button variant="outline" onClick={() => setCandidates(undefined)}>
                  取消
                </Button>
                <Button
                  disabled={isDisabled}
                  onClick={() =>
                    void act(async () => {
                      let latest = await call('read')
                      for (const group of data.groups.filter((g) => g.ready)) {
                        const options = candidates.filter((item) => item.group === group.id)
                        const chosen = options
                          .filter((item) => selected.has(ref(group.id, item.model.id)))
                          .map((item) => item.model)
                        const revision = latest.groups.find((g) => g.id === group.id)!.revision
                        const original = data.groups.find((g) => g.id === group.id)!
                        const current = latest.groups.find((g) => g.id === group.id)!
                        if (JSON.stringify(current.models) !== JSON.stringify(original.models))
                          throw Error('模型已被其他操作修改，请重新选择')
                        if (JSON.stringify(chosen) === JSON.stringify(current.models)) continue
                        latest = await call('edit', {
                          group: group.id,
                          models: chosen,
                          api: group.api,
                          revision,
                        })
                      }
                      setData(latest)
                      setCandidates(undefined)
                    })
                  }
                >
                  保存选择
                </Button>
              </div>
            </div>
          )}

          <details
            className={css.details}
            onToggle={(event) => {
              if (event.target === event.currentTarget) setEditing(event.currentTarget.open)
            }}
          >
            <summary>手动配置模型与接口协议</summary>
            {editing && activeManualGroup && (
              <div className={css.editor}>
                <p className={css.muted}>每个渠道独立配置。默认协议已自动设定，通常无需更改。</p>
                <label className={css.field}>
                  <span>编辑分组</span>
                  <select
                    className={css.input}
                    value={activeManualGroup.id}
                    disabled={isDisabled}
                    onChange={(e) => setManualGroup(e.target.value)}
                  >
                    {resolvedEditableGroups.map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.name} · {group.models.length} 个模型
                      </option>
                    ))}
                  </select>
                </label>

                <Button
                  variant="outline"
                  disabled={isDisabled || !activeManualGroup.ready}
                  onClick={() =>
                    void act(async () => {
                      const fetched = await call('discover', { group: activeManualGroup.id })
                      const ids = new Set(activeManualGroup.models.map((model) => model.id))
                      change(activeManualGroup.id, {
                        models: [
                          ...activeManualGroup.models,
                          ...fetched.filter((model) => !ids.has(model.id)),
                        ],
                        catalog: fetched.length
                          ? { state: 'ready', count: fetched.length }
                          : { state: 'empty', count: 0 },
                      })
                    })
                  }
                >
                  获取可用模型
                </Button>

                {activeManualGroup.models.map((model, index) => (
                  <div className={css.detailsBody} key={index}>
                    <label className={css.field}>
                      <span>模型 ID</span>
                      <input
                        className={css.input}
                        disabled={isDisabled}
                        value={model.id}
                        onChange={(e) =>
                          change(activeManualGroup.id, {
                            models: activeManualGroup.models.map((item, i) =>
                              i === index ? { ...item, id: e.target.value } : item,
                            ),
                          })
                        }
                      />
                    </label>
                    <label className={css.field}>
                      <span>显示名称</span>
                      <input
                        className={css.input}
                        disabled={isDisabled}
                        value={model.name ?? ''}
                        onChange={(e) =>
                          change(activeManualGroup.id, {
                            models: activeManualGroup.models.map((item, i) =>
                              i === index ? { ...item, name: e.target.value } : item,
                            ),
                          })
                        }
                      />
                    </label>
                    <label className={css.field}>
                      <span>上下文长度</span>
                      <input
                        type="number"
                        min="1"
                        className={css.input}
                        disabled={isDisabled}
                        value={model.contextWindow ?? ''}
                        onChange={(e) =>
                          change(activeManualGroup.id, {
                            models: activeManualGroup.models.map((item, i) => {
                              if (i !== index) return item
                              const { contextWindow: _, ...rest } = item
                              return e.target.value
                                ? { ...rest, contextWindow: Number(e.target.value) }
                                : rest
                            }),
                          })
                        }
                      />
                    </label>
                    <Button
                      variant="outline"
                      disabled={isDisabled}
                      onClick={() =>
                        change(activeManualGroup.id, {
                          models: activeManualGroup.models.filter((_, i) => i !== index),
                        })
                      }
                    >
                      移除模型
                    </Button>
                  </div>
                ))}

                {!activeManualGroup.models.length && (
                  <p className={css.muted}>目录为空，可获取可用模型或手动添加。</p>
                )}

                <Button
                  variant="outline"
                  disabled={isDisabled}
                  onClick={() =>
                    change(activeManualGroup.id, {
                      models: [...activeManualGroup.models, { id: '', name: '' }],
                    })
                  }
                >
                  添加模型
                </Button>

                {activeManualGroup.id !== 'deepseek' && (
                  <label className={css.field}>
                    <span>{activeManualGroup.name} 接口协议</span>
                    <select
                      aria-label={`${activeManualGroup.name} 接口协议`}
                      className={css.input}
                      disabled={isDisabled}
                      value={activeManualGroup.api}
                      onChange={(e) => change(activeManualGroup.id, { api: e.target.value })}
                    >
                      <option value="openai-responses">OpenAI Responses</option>
                      <option value="openai-completions">OpenAI Chat Completions</option>
                      <option value="anthropic-messages">Anthropic Messages</option>
                    </select>
                  </label>
                )}

                <Button
                  disabled={isDisabled}
                  onClick={() =>
                    void act(async () => {
                      const saved = await call('edit', {
                        group: activeManualGroup.id,
                        models: activeManualGroup.models,
                        api: activeManualGroup.api,
                        revision: activeManualGroup.revision,
                      })
                      setData((current) => ({
                        groups: saved.groups.map((next) =>
                          next.id === activeManualGroup.id
                            ? next
                            : {
                                ...(current?.groups.find((item) => item.id === next.id) ?? next),
                                revision: next.revision,
                              },
                        ),
                      }))
                    })
                  }
                >
                  保存模型
                </Button>
              </div>
            )}
          </details>
        </>
      )}
    </div>
  )
}
