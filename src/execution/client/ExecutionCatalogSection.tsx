import { useExecutionCatalog } from './use-execution-catalog.ts'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { displayModelSource, selectableModels, modelRefKey } from '../contracts/catalog.ts'
import { isOfficialPairing } from '../contracts/official-harnesses.ts'
import type { CombinationDefinition, ExecutionCatalog } from '../contracts/catalog.ts'
import type { HarnessCatalog } from '../../contracts/types.ts'
import type { RemoteCallInput } from '../../shared/client/remote-call.ts'
import type { TypertRemoteNamespace } from '@deepseek-ai/dsh-typert-protocol'
import css from '../../shared/client/SettingsSection.module.css'
import type { ExecutionCall as Call } from '../../shared/client/remote-call.ts'
import type { CombinationDefinition } from '../../contracts/types.ts'
export function ExecutionCatalogSection({
  call,
  embedded = false,
}: {
  call: RemoteCallInput<TypertRemoteNamespace<'oplExecution'>>
  embedded?: boolean
}) {
  const {
    catalog,
    availability,
    busy,
    notice,
    retry,
    draft,
    setDraft,
    editing,
    setEditing,
    update,
    add,
  } = useExecutionCatalog(call)
  const renderCombination = (item: CombinationDefinition) => {
    if (!catalog) return null
    const model = catalog.models.find((x) => modelRefKey(x.ref) === modelRefKey(item.modelRef))
    const harness = catalog.harnesses.find((x) => x.id === item.harnessRef)
    const status = availability.find((c) => c.id === item.id)
    return (
      <details
        className={css.card}
        key={item.id}
        open={editing === item.id}
        onToggle={(event) => {
          const open = event.currentTarget.open
          setEditing((current) => (open ? item.id : current === item.id ? undefined : current))
        }}
      >
        <summary className={css.header}>
          <span className={css.identity}>
            <strong>{item.name}</strong>
            {item.isDefault && item.enabled && (
              <span className={css.muted}>此模型的默认执行组合</span>
            )}
            <span className={css.muted}>
              {displayModelSource(item.modelRef, model?.source)} ·{' '}
              {model?.name ?? item.modelRef.model} · {harness?.name ?? item.harnessRef}
            </span>
          </span>
          <span className={css.row}>
            <span className={css.muted}>
              {!item.enabled
                ? '已停用'
                : status?.available
                  ? '可执行'
                  : (status?.reason ?? model?.reason ?? '尚未验证')}
            </span>
            <Switch
              label={`启用 ${item.name}`}
              disabled={busy}
              checked={item.enabled}
              onChange={(enabled) => update(item.id, { enabled })}
            />
          </span>
        </summary>
        <div className={css.detailsBody}>
          <label className={css.field}>
            配置名称
            <input
              className={css.input}
              defaultValue={item.name}
              disabled={busy}
              onBlur={(e) => {
                if (e.target.value !== item.name) update(item.id, { name: e.target.value })
              }}
            />
          </label>
          <div className={css.row}>
            <Switch
              label="作为此模型的默认执行组合"
              disabled={busy || !item.enabled}
              checked={item.isDefault}
              onChange={(isDefault) => update(item.id, { isDefault })}
            />
            <span className={css.muted}>默认执行组合</span>
          </div>
          <label className={css.field}>
            权限
            <select
              className={css.input}
              value={item.permissionPolicy}
              disabled={busy}
              onChange={(e) =>
                update(item.id, {
                  permissionPolicy: e.target.value as 'workspace' | 'read-only' | 'full-access',
                })
              }
            >
              <option value="read-only">只读</option>
              <option value="workspace">工作区内修改（仍需 Harness 授权）</option>
              {item.harnessRef === 'minimax-code' && (
                <option value="full-access">完整访问（使用 MiniMax 官方 CLI 授权）</option>
              )}
            </select>
          </label>
        </div>
      </details>
    )
  }
  return (
    <div className={css.section} data-opl-panel="catalog" aria-busy={busy || (!catalog && !notice)}>
      {embedded ? null : <h2 className={css.title}>执行组合</h2>}
      {embedded ? null : (
        <p className={css.intro}>
          保存模型、渠道、Harness
          与权限的搭配。已启用的组合显示在官方会话输入框中，未就绪项显示原因；委派任务和交付由后台保存。模型在“模型供应商”页管理，账号与凭据在“网关账户”中管理。
        </p>
      )}
      {!catalog && !notice && (
        <p className={css.muted} role="status">
          正在加载组合…
        </p>
      )}
      {notice && (
        <p role={catalog ? 'status' : 'alert'} className={css.notice}>
          {notice}
        </p>
      )}
      {!catalog && notice && <Button onClick={retry}>重试</Button>}
      {catalog && (
        <details className={css.details} data-opl-panel="custom-combinations">
          <summary>自定义执行组合</summary>
          <div className={css.detailsBody}>
            <label className={css.field}>
              名称
              <input
                className={css.input}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <label className={css.field}>
              模型
              <select
                className={css.input}
                value={draft.model}
                onChange={(e) => setDraft({ ...draft, model: e.target.value })}
              >
                <option value="">选择模型</option>
                {selectableModels(catalog.models).map((model) => (
                  <option key={modelRefKey(model.ref)} value={modelRefKey(model.ref)}>
                    {displayModelSource(model.ref, model.source)} · {model.name}
                    {model.available ? '' : ' · 未就绪'}
                  </option>
                ))}
              </select>
            </label>
            <label className={css.field}>
              Harness
              <select
                className={css.input}
                value={draft.harness}
                onChange={(e) => setDraft({ ...draft, harness: e.target.value })}
              >
                {catalog.harnesses.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
              </select>
            </label>
            <p className={css.muted}>
              手动组合可自由选择任意已就绪模型和执行引擎；它不是厂商官配，只有当前配置的默认项会自动生成。
            </p>
            <Button
              disabled={busy || !draft.name.trim() || !draft.model}
              onClick={() => void add()}
            >
              保存执行组合
            </Button>
          </div>
        </details>
      )}
      {catalog && (
        <details className={css.details} data-opl-panel="combination-list" open>
          <summary>执行组合列表</summary>
          <div className={css.detailsBody}>
            <section data-opl-panel="official-combinations">
              <h3>官方组合</h3>
              {catalog.combinations.filter((item) => item.generated).map(renderCombination)}
            </section>
            <section data-opl-panel="custom-combination-list">
              <h3>自定义组合</h3>
              {catalog.combinations.filter((item) => !item.generated).map(renderCombination)}
            </section>
          </div>
        </details>
      )}
    </div>
  )
}

function CombinationRow({
  item,
  catalog,
  availability,
  busy,
  editing,
  setEditing,
  update,
}: {
  item: CombinationDefinition
  catalog: ExecutionCatalog
  availability: HarnessCatalog['combinations']
  busy: boolean
  editing: string | undefined
  setEditing: (
    value: string | undefined | ((current: string | undefined) => string | undefined),
  ) => void
  update: ReturnType<typeof useExecutionCatalog>['update']
}) {
  const model = catalog.models.find((x) => modelRefKey(x.ref) === modelRefKey(item.modelRef)),
    harness = catalog.harnesses.find((x) => x.id === item.harnessRef)
  const status = availability.find((c) => c.id === item.id)
  const readiness = status?.available
    ? status
    : model?.available === true
      ? { available: true }
      : {
          available: false,
          reason: status?.reason ?? model?.reason ?? '尚未验证',
        }
  return (
    <details
      className={css.card}
      data-opl-combination={item.id}
      open={editing === item.id}
      onToggle={(event) => {
        const open = event.currentTarget.open
        setEditing((current) => (open ? item.id : current === item.id ? undefined : current))
      }}
    >
      <summary className={css.header}>
        <span className={css.identity}>
          <strong>{item.name}</strong>
          {!item.generated && !isOfficialPairing(item.harnessRef, item.modelRef) && (
            <span className={css.muted} data-opl-custom-combination>
              自定义
            </span>
          )}
          {item.isDefault && item.enabled && (
            <span className={css.muted}>此模型的默认执行组合</span>
          )}
          <span className={css.muted}>
            {displayModelSource(item.modelRef, model?.source)} ·{' '}
            {model?.name ?? item.modelRef.model} · {harness?.name ?? item.harnessRef}
          </span>
        </span>
        <span className={css.row}>
          <span className={css.muted}>
            {!item.enabled ? '已停用' : readiness.available ? '可执行' : readiness.reason}
          </span>
          <Switch
            label={`启用 ${item.name}`}
            disabled={busy}
            checked={item.enabled}
            onChange={(enabled) => update(item.id, { enabled })}
          />
        </span>
      </summary>
      <div className={css.detailsBody}>
        <label className={css.field}>
          配置名称
          <input
            className={css.input}
            defaultValue={item.name}
            disabled={busy}
            onBlur={(e) => {
              if (e.target.value !== item.name) update(item.id, { name: e.target.value })
            }}
          />
        </label>
        <div className={css.row}>
          <Switch
            label="作为此模型的默认执行组合"
            disabled={busy || !item.enabled}
            checked={item.isDefault}
            onChange={(isDefault) => update(item.id, { isDefault })}
          />
          <span className={css.muted}>默认执行组合</span>
        </div>
        <label className={css.field}>
          权限
          <select
            className={css.input}
            value={item.permissionPolicy}
            disabled={busy}
            onChange={(e) =>
              update(item.id, {
                permissionPolicy: e.target.value as 'workspace' | 'read-only' | 'full-access',
              })
            }
          >
            <option value="read-only">只读</option>
            <option value="workspace">工作区内修改（仍需 Harness 授权）</option>
            {item.harnessRef !== 'antigravity' && (
              <option value="full-access">完整访问（使用该执行引擎的官方授权）</option>
            )}
          </select>
        </label>
      </div>
    </details>
  )
}
