import { useEffect, useState } from 'react'
import { RecommendationPicker } from './RecommendationPicker.tsx'
import { ModelAvailabilityStatus } from './ModelAvailabilityStatus.tsx'
import { useExecutionCatalog } from './use-execution-catalog.ts'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  displayModelName,
  displayModelSource,
  selectableModels,
  modelRefKey,
} from '../contracts/catalog.ts'
import { isOfficialPairing } from '../contracts/official-harnesses.ts'
import {
  combinationChoices,
  defaultPermissionPolicy,
  pairingPermissionPolicies,
  recommendationChoiceKey,
} from './combination-choices.ts'
import { defaultExecutionT, type ExecutionSettingsT } from './execution-settings-locales.ts'
import type { CombinationDefinition, ExecutionCatalog } from '../contracts/catalog.ts'
import type { HarnessCatalog } from '../../contracts/types.ts'
import type { RemoteCallInput } from '../../shared/client/remote-call.ts'
import type { TypertRemoteNamespace } from '@deepseek-ai/dsh-typert-protocol'
import css from '../../shared/client/SettingsSection.module.css'
import listCss from './CombinationRows.module.css'

function permissionLabel(
  t: ExecutionSettingsT,
  policy: CombinationDefinition['permissionPolicy'],
): string {
  if (policy === 'read-only') return t('permissionReadOnly')
  if (policy === 'workspace') return t('permissionWorkspace')
  return t('permissionFullAccess')
}

export function ExecutionCatalogSection({
  call,
  embedded = false,
  refreshKey,
  t = defaultExecutionT,
}: {
  call: RemoteCallInput<TypertRemoteNamespace<'oplExecution'>>
  embedded?: boolean
  /** Reload the projection without discarding drafts or in-flight save feedback. */
  refreshKey?: unknown
  t?: ExecutionSettingsT
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
    addRecommendations,
    removeCombination,
  } = useExecutionCatalog(call, refreshKey, t)
  const [recommendationsOpen, setRecommendationsOpen] = useState(false)
  const choices = catalog ? combinationChoices(catalog) : []
  const availableRecommendations = new Set(
    catalog?.recommendations?.map(recommendationChoiceKey) ?? [],
  )
  const recommendationCount = choices.filter((choice) =>
    availableRecommendations.has(choice.key),
  ).length
  useEffect(() => {
    if (recommendationCount > 0) setRecommendationsOpen(true)
  }, [recommendationCount])
  const supportedHarnesses =
    catalog?.supportedPairings?.find((item) => modelRefKey(item.modelRef) === draft.model)
      ?.harnessRefs ?? []
  const remainingHarnesses = supportedHarnesses.filter(
    (harnessRef) =>
      ![...(catalog?.combinations ?? []), ...(catalog?.recommendations ?? [])].some(
        (item) => modelRefKey(item.modelRef) === draft.model && item.harnessRef === harnessRef,
      ),
  )
  const selectedHarness = remainingHarnesses.includes(draft.harness) ? draft.harness : ''
  const permissionPolicies =
    catalog && draft.model ? pairingPermissionPolicies(catalog, draft.model, selectedHarness) : []
  const selectedPermission = permissionPolicies.includes(draft.permissionPolicy)
    ? draft.permissionPolicy
    : defaultPermissionPolicy(permissionPolicies)
  return (
    <div className={css.section} data-opl-panel="catalog" aria-busy={busy || (!catalog && !notice)}>
      {embedded ? null : <h2 className={css.title}>{t('catalogTitle')}</h2>}
      {embedded ? null : <p className={css.intro}>{t('catalogIntro')}</p>}
      {!catalog && !notice && (
        <p className={css.muted} role="status">
          {t('catalogLoading')}
        </p>
      )}
      {notice && (
        <p role={catalog ? 'status' : 'alert'} className={css.notice}>
          {notice}
        </p>
      )}
      {!catalog && notice && <Button onClick={retry}>{t('catalogRetry')}</Button>}
      {catalog?.ofmDiscovery && catalog.ofmDiscovery.length > 0 && (
        <details className={css.details} data-opl-panel="ofm-discovery">
          <summary>{t('ofmDiscoverySummary', { count: catalog.ofmDiscovery.length })}</summary>
          <div className={css.detailsBody}>
            <p className={css.muted}>{t('ofmDiscoveryIntro')}</p>
            <div className={listCss.discoveryList}>
              {catalog.ofmDiscovery.map((item) => (
                <div className={listCss.discoveryRow} key={modelRefKey(item.modelRef)}>
                  <span className={listCss.discoveryName}>{item.name}</span>
                  <span className={listCss.discoveryMetadata} title={item.modelRef.model}>
                    <ModelAvailabilityStatus {...item} t={t} />
                    <span className={listCss.discoveryStatus}>{item.status.label}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </details>
      )}
      {catalog &&
        (catalog.combinations.length > 0 || (catalog.recommendations?.length ?? 0) > 0) && (
          <details
            className={css.details}
            data-opl-panel="recommended-combinations"
            open={recommendationsOpen}
            onToggle={(event) => setRecommendationsOpen(event.currentTarget.open)}
          >
            <summary>{t('recommendedSummary', { count: choices.length })}</summary>
            <div className={css.detailsBody}>
              <RecommendationPicker
                catalog={catalog}
                busy={busy}
                onAdd={addRecommendations}
                onRemove={removeCombination}
                t={t}
              />
            </div>
          </details>
        )}
      {catalog && (
        <details className={css.details} data-opl-panel="custom-combinations">
          <summary>{t('customAddSummary')}</summary>
          <form
            className={css.detailsBody}
            aria-label={t('customAddSummary')}
            onSubmit={(event) => {
              event.preventDefault()
              void add()
            }}
          >
            <label className={css.field}>
              {t('modelField')}
              <select
                className={css.input}
                name="model"
                required
                value={draft.model}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    model: e.target.value,
                    harness: '',
                    permissionPolicy: 'workspace',
                  })
                }
              >
                <option value="">{t('selectModelPlaceholder')}</option>
                {selectableModels(catalog.models).map((model) => (
                  <option key={modelRefKey(model.ref)} value={modelRefKey(model.ref)}>
                    {displayModelSource(model.ref, model.source)} ·{' '}
                    {displayModelName(model.ref, model.name)}
                  </option>
                ))}
              </select>
            </label>
            <label className={css.field}>
              {t('harnessField')}
              <select
                className={css.input}
                name="harness"
                required
                value={selectedHarness}
                disabled={busy || !draft.model || !remainingHarnesses.length}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    harness: e.target.value,
                    permissionPolicy: 'workspace',
                  })
                }
              >
                <option value="">
                  {!draft.model
                    ? t('selectModelFirstPlaceholder')
                    : remainingHarnesses.length
                      ? t('selectHarnessPlaceholder')
                      : t('noMoreHarnessesPlaceholder')}
                </option>
                {catalog.harnesses
                  .filter((h) => remainingHarnesses.includes(h.id))
                  .map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name}
                    </option>
                  ))}
              </select>
            </label>
            <label className={css.field}>
              {t('permissionField')}
              <select
                className={css.input}
                name="permission"
                required
                value={selectedPermission ?? ''}
                disabled={busy || permissionPolicies.length < 2}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    permissionPolicy: e.target.value as typeof draft.permissionPolicy,
                  })
                }
              >
                <option value="">{t('selectPermissionPlaceholder')}</option>
                {permissionPolicies.map((policy) => (
                  <option key={policy} value={policy}>
                    {permissionLabel(t, policy)}
                  </option>
                ))}
              </select>
            </label>
            {permissionPolicies.length === 1 && selectedPermission && (
              <p className={css.muted}>
                {t('singlePermissionNote', {
                  permission: permissionLabel(t, selectedPermission),
                })}
                {selectedPermission === 'full-access' && t('fullAccessSessionHint')}
              </p>
            )}
            <Button
              type="submit"
              variant="primary"
              disabled={busy || !draft.model || !selectedHarness || !selectedPermission}
            >
              {t('saveCombinationButton')}
            </Button>
          </form>
        </details>
      )}
      {catalog &&
        (() => {
          const combinations = catalog.combinations.filter((item) => item.enabled)
          const official = combinations.filter((item) =>
            isOfficialPairing(item.harnessRef, item.modelRef),
          )
          const custom = combinations.filter((item) => !official.includes(item))
          const renderRow = (item: CombinationDefinition) => (
            <CombinationRow
              key={item.id}
              item={item}
              catalog={catalog}
              availability={availability}
              busy={busy}
              editing={editing}
              setEditing={setEditing}
              update={update}
              t={t}
            />
          )
          return (
            <>
              <details className={css.details} data-opl-panel="combination-list" open>
                <summary>{t('enabledCombinationsSummary')}</summary>
                <div className={css.detailsBody}>
                  {official.length > 0 && (
                    <section className={listCss.group} data-opl-panel="official-combinations">
                      <h3>{t('officialCombinationsHeading')}</h3>
                      {official.map(renderRow)}
                    </section>
                  )}
                  {custom.length > 0 && (
                    <section className={listCss.group} data-opl-panel="custom-combination-list">
                      <h3>{t('customCombinationsHeading')}</h3>
                      {custom.map(renderRow)}
                    </section>
                  )}
                </div>
              </details>
            </>
          )
        })()}
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
  t,
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
  t: ExecutionSettingsT
}) {
  const model = catalog.models.find((x) => modelRefKey(x.ref) === modelRefKey(item.modelRef)),
    harness = catalog.harnesses.find((x) => x.id === item.harnessRef)
  const status = availability.find((c) => c.id === item.id)
  const availabilityState =
    model?.available === false
      ? model
      : (status ?? {
          available: false,
          unavailableKind: 'unconfirmed' as const,
          reason: t('combinationUnconfirmedReason'),
        })
  const failure = !availabilityState.available
  const hasAlternatives =
    catalog.combinations.filter(
      (candidate) =>
        candidate.enabled && modelRefKey(candidate.modelRef) === modelRefKey(item.modelRef),
    ).length > 1
  const source = displayModelSource(item.modelRef, model?.source)
  const modelName = displayModelName(item.modelRef, model?.name)
  const routeSeparator = item.modelRef.model.indexOf('::')
  const modelId =
    item.modelRef.provider === 'opl-gateway' && routeSeparator >= 0
      ? item.modelRef.model.slice(routeSeparator + 2)
      : item.modelRef.model
  const harnessName = harness?.name ?? item.harnessRef
  const hasHarnessLabel =
    item.name.includes(` + ${harnessName}`) || item.name.endsWith(` · ${harnessName}`)
  const description = `${source} · ${modelName} · ${harnessName}`
  return (
    <details
      className={listCss.item}
      data-opl-combination={item.id}
      open={editing === item.id}
      onToggle={(event) => {
        const open = event.currentTarget.open
        setEditing((current) => (open ? item.id : current === item.id ? undefined : current))
      }}
    >
      <summary className={listCss.summary}>
        <span className={listCss.name} title={`${item.name} · ${description}`}>
          {item.name}
          {hasHarnessLabel ? null : ` · ${harnessName}`}
        </span>
        <span className={listCss.metadata}>
          <ModelAvailabilityStatus {...availabilityState} t={t} />
          <span className={listCss.source} title={source}>
            {source}
          </span>
          {failure && (
            <button
              type="button"
              className={listCss.remove}
              disabled={busy}
              aria-label={t('removeCombinationAriaLabel', { name: item.name })}
              title={t('removeCombinationTitle')}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                update(item.id, { enabled: false })
              }}
            >
              {t('removeButton')}
            </button>
          )}
        </span>
      </summary>
      <div className={`${css.detailsBody} ${listCss.editor}`}>
        <dl className={listCss.modelDetails}>
          <dt>{t('modelNameLabel')}</dt>
          <dd>{modelName}</dd>
          <dt>{t('modelIdLabel')}</dt>
          <dd>
            <code>{modelId}</code>
          </dd>
        </dl>
        <label className={css.field}>
          {t('combinationNameField')}
          <input
            className={css.input}
            defaultValue={item.name}
            disabled={busy}
            onBlur={(e) => {
              if (e.target.value !== item.name) update(item.id, { name: e.target.value })
            }}
          />
        </label>
        {hasAlternatives && (
          <div className={css.row}>
            <Switch
              label={t('defaultCombinationSwitchLabel')}
              disabled={busy || !item.enabled}
              checked={item.isDefault}
              onChange={(isDefault) => update(item.id, { isDefault })}
            />
            <span className={css.muted}>{t('defaultCombinationLabel')}</span>
          </div>
        )}
      </div>
    </details>
  )
}
