import { useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { displayModelName, displayModelSource, modelRefKey } from '../contracts/catalog.ts'
import type { ExecutionCatalog } from '../contracts/catalog.ts'
import css from './RecommendationPicker.module.css'
import settingsCss from '../../shared/client/SettingsSection.module.css'
import {
  combinationChoices,
  pairingPermissionPolicies,
  savedChoiceKey,
} from './combination-choices.ts'
import type { CombinationSelection } from './combination-choices.ts'
import { defaultExecutionT, type ExecutionSettingsT } from './execution-settings-locales.ts'

/** One selection surface controls saved configurations and new recommendations. */
export function RecommendationPicker({
  catalog,
  busy,
  onAdd,
  onRemove,
  t = defaultExecutionT,
}: {
  catalog: ExecutionCatalog
  busy: boolean
  onRemove: (id: string) => Promise<boolean>
  onAdd: (selection: CombinationSelection) => Promise<void>
  t?: ExecutionSettingsT
}) {
  const removing = useRef<{ id: string; edits: Map<string, boolean> } | undefined>(undefined)
  const candidates = combinationChoices(catalog).map((item) => [item.key, item] as const)
  const fullAccessOnly = new Set(
    candidates
      .filter(([, item]) => {
        const policies = pairingPermissionPolicies(
          catalog,
          modelRefKey(item.modelRef),
          item.harnessRef,
        )
        return policies.length === 1 && policies[0] === 'full-access'
      })
      .map(([key]) => key),
  )
  const enabled = () => new Set(candidates.filter(([, item]) => item.enabled).map(([key]) => key))
  const [selected, setSelected] = useState<Set<string>>(enabled)
  const [disabledIds, setDisabledIds] = useState<Set<string>>(() => new Set())
  const [query, setQuery] = useState('')
  useEffect(() => {
    const pending = removing.current
    if (pending && !catalog.combinations.some((row) => row.id === pending.id)) {
      removing.current = undefined
      setSelected(
        new Set(
          candidates
            .filter(([key, item]) => pending.edits.get(key) ?? item.enabled)
            .map(([key]) => key),
        ),
      )
      return
    }
    setSelected(enabled())
    setDisabledIds(new Set())
  }, [catalog])
  const normalizedQuery = query.trim().toLowerCase()
  const modelNames = new Map(catalog.models.map((model) => [modelRefKey(model.ref), model.name]))
  const visible = candidates.filter(([, item]) => {
    const harnessName = catalog.harnesses.find((harness) => harness.id === item.harnessRef)?.name
    const searchable = [
      item.name,
      displayModelName(item.modelRef, modelNames.get(modelRefKey(item.modelRef))),
      displayModelSource(item.modelRef),
      item.modelRef.model,
      harnessName,
    ]
      .join(' ')
      .toLowerCase()
    return normalizedQuery.split(/\s+/u).every((term) => searchable.includes(term))
  })
  const groups = [...new Set(visible.map(([, item]) => item.harnessRef))]
  const count = candidates.filter(([key]) => selected.has(key)).length
  const visibleIds = new Set(candidates.map(([, item]) => item.key))
  const hiddenEnabled = catalog.combinations.some(
    (item) => item.enabled && !visibleIds.has(savedChoiceKey(item.id)) && !disabledIds.has(item.id),
  )
  const toggle = (keys: string[], checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current)
      for (const key of keys) checked ? next.add(key) : next.delete(key)
      return next
    })
  const clearSaved = (harness?: string) =>
    setDisabledIds(
      (current) =>
        new Set([
          ...current,
          ...catalog.combinations
            .filter((item) => harness === undefined || item.harnessRef === harness)
            .map((item) => item.id),
        ]),
    )
  if (!candidates.length && !catalog.combinations.some((item) => item.enabled)) return null
  return (
    <div className={css.picker}>
      <div className={css.toolbar}>
        <search className={css.search}>
          <label>
            <span>{t('filterLabel')}</span>
            <input
              type="search"
              name="filter"
              className={settingsCss.input}
              placeholder={t('filterPlaceholder')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </search>
        {!normalizedQuery && (
          <>
            <Button
              type="button"
              disabled={busy || !candidates.length}
              onClick={() =>
                toggle(
                  candidates.map(([key]) => key),
                  true,
                )
              }
            >
              {t('selectAllButton')}
            </Button>
            <Button
              type="button"
              disabled={busy || (!count && !hiddenEnabled)}
              onClick={() => {
                setSelected(new Set())
                clearSaved()
              }}
            >
              {t('clearAllButton')}
            </Button>
          </>
        )}
      </div>
      <form
        className={css.selection}
        aria-label={t('pickerFormLabel')}
        onSubmit={(event) => {
          event.preventDefault()
          void onAdd({
            selected: new Set(candidates.filter(([key]) => selected.has(key)).map(([key]) => key)),
            disabledIds: new Set(disabledIds),
          })
        }}
      >
        {visible.length === 0 && (
          <p className={css.muted} role="status">
            {normalizedQuery ? t('pickerNoMatch') : t('pickerNoOptions')}
          </p>
        )}
        <div className={css.groups}>
          {groups.map((harness) => {
            const items = visible.filter(([, item]) => item.harnessRef === harness)
            const groupRequiresFullAccess = candidates
              .filter(([, item]) => item.harnessRef === harness)
              .every(([key]) => fullAccessOnly.has(key))
            const checked = items.filter(([key]) => selected.has(key)).length
            const name = catalog.harnesses.find((item) => item.id === harness)?.name ?? harness
            return (
              <fieldset className={css.group} key={harness}>
                <legend className={css.groupLabel}>
                  <label>
                    <input
                      type="checkbox"
                      name="combination-group"
                      value={harness}
                      disabled={busy}
                      checked={checked === items.length}
                      ref={(node) => {
                        if (node) node.indeterminate = checked > 0 && checked < items.length
                      }}
                      data-opl-recommendation-group={harness}
                      onChange={(event) => {
                        toggle(
                          items.map(([key]) => key),
                          event.target.checked,
                        )
                        if (!event.target.checked && !normalizedQuery) clearSaved(harness)
                      }}
                    />
                    <span>
                      {t('pickerGroupHeader', { name, checked, total: items.length })}
                      {groupRequiresFullAccess && (
                        <span className={css.permission}>{t('pickerFullAccessOnlyTag')}</span>
                      )}
                    </span>
                  </label>
                </legend>
                {items.map(([key, item]) => {
                  return (
                    <div className={css.choiceRow} key={key}>
                      <label className={css.item}>
                        <input
                          type="checkbox"
                          name="combination"
                          value={key}
                          disabled={busy}
                          checked={selected.has(key)}
                          data-opl-recommendation-item={key}
                          onChange={(event) => toggle([key], event.target.checked)}
                        />
                        <span className={css.itemText}>
                          <span>
                            {displayModelSource(item.modelRef)} · {item.name}
                          </span>
                          {!groupRequiresFullAccess && fullAccessOnly.has(key) && (
                            <span className={css.permission}>{t('pickerFullAccessOnlyTag')}</span>
                          )}
                        </span>
                      </label>
                      {item.removableId && (
                        <button
                          type="button"
                          className={css.remove}
                          disabled={busy}
                          aria-label={t('pickerRemoveCustomAriaLabel', { name: item.name })}
                          onClick={async () => {
                            if (removing.current) return
                            const id = item.removableId!
                            const edits = new Map(
                              candidates
                                .filter(([key, item]) => selected.has(key) !== item.enabled)
                                .map(([key]) => [key, selected.has(key)]),
                            )
                            removing.current = { id, edits }
                            if (!(await onRemove(id))) removing.current = undefined
                          }}
                        >
                          {t('removeButton')}
                        </button>
                      )}
                    </div>
                  )
                })}
              </fieldset>
            )
          })}
        </div>
        <Button variant="primary" type="submit" disabled={busy}>
          {t('pickerSaveButton', { count })}
        </Button>
        {visible.some(([key]) => fullAccessOnly.has(key)) && (
          <p className={css.muted}>{t('pickerFullAccessHint')}</p>
        )}
      </form>
    </div>
  )
}
