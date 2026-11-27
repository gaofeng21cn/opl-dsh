import { useEffect, useRef, useState } from 'react'
import type { TypertRemoteNamespace } from '@deepseek-ai/dsh-typert-protocol'
import { displayModelName, modelRefKey } from '../contracts/catalog.ts'
import { isOfficialPairing } from '../contracts/official-harnesses.ts'
import {
  combinationChoices,
  defaultPermissionPolicy,
  pairingKey,
  pairingPermissionPolicies,
  savedChoiceKey,
  recommendationChoiceKey,
} from './combination-choices.ts'
import type { CombinationSelection } from './combination-choices.ts'
import { defaultExecutionT, type ExecutionSettingsT } from './execution-settings-locales.ts'
import { safeFailureMessage } from './proxy-draft.ts'
import type {
  ExecutionCatalog,
  CombinationDefinition,
  HarnessCatalog,
} from '../../contracts/types.ts'
import type { RemoteCallInput } from '../../shared/client/remote-call.ts'
/**
 * The catalog is one document, so a save is all-or-nothing. `blocked` is kept apart
 * from `failed`: a save that never ran because another one was in flight must not
 * be reported as the user having changed their settings.
 */
export type SaveResult =
  | { status: 'saved'; catalog: ExecutionCatalog }
  | { status: 'failed'; message: string }
  | { status: 'blocked' }
export function useExecutionCatalog(
  call: RemoteCallInput<TypertRemoteNamespace<'oplExecution'>>,
  refreshKey?: unknown,
  t: ExecutionSettingsT = defaultExecutionT,
) {
  const [catalog, setCatalog] = useState<ExecutionCatalog>()
  const [availability, setAvailability] = useState<HarnessCatalog['combinations']>([])
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('')
  const [loadRevision, setLoadRevision] = useState(0)
  const [draft, setDraft] = useState({
    model: '',
    harness: 'dsh',
    permissionPolicy: 'workspace' as CombinationDefinition['permissionPolicy'],
  })
  const [editing, setEditing] = useState<string>()
  const running = useRef(false),
    mounted = useRef(true),
    refreshAfterSave = useRef(false),
    tRef = useRef(t)
  tRef.current = t
  useEffect(() => {
    mounted.current = true
    if (running.current) {
      // A MiniMax projection change must not race an ordinary catalog save.
      // Preserve the component and reload only after that save has settled.
      refreshAfterSave.current = true
      return () => {
        mounted.current = false
      }
    }
    let cancelled = false
    void (async () => {
      for (let attempt = 0; attempt < 3 && !cancelled; attempt++) {
        try {
          const [next, combinations] = await Promise.all([
            call('catalog'),
            call('combinations', { includeDisabled: true }),
          ])
          if (!cancelled) {
            setCatalog(next)
            setAvailability(combinations)
            setNotice('')
          }
          return
        } catch {
          if (attempt === 2) {
            if (!cancelled) setNotice(tRef.current('catalogLoadFailed'))
          } else {
            await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
          }
        }
      }
    })()
    return () => {
      cancelled = true
      mounted.current = false
    }
  }, [call, loadRevision, refreshKey])
  const persist = async (operation: () => Promise<ExecutionCatalog>): Promise<SaveResult> => {
    if (running.current) {
      if (mounted.current) setNotice(tRef.current('anotherSaveInFlight'))
      return { status: 'blocked' }
    }
    running.current = true
    setBusy(true)
    setNotice('')
    try {
      const saved = await operation()
      if (mounted.current) setCatalog(saved)
      try {
        const combinations = await call('combinations', { includeDisabled: true })
        if (mounted.current) {
          setAvailability(combinations)
          setNotice(tRef.current('catalogSavedNotice'))
        }
      } catch {
        if (mounted.current) setNotice(tRef.current('catalogSavedPartialNotice'))
      }
      return { status: 'saved', catalog: saved }
    } catch (cause) {
      const message = safeFailureMessage(cause, tRef.current('saveFailed'))
      if (mounted.current) setNotice(message)
      return { status: 'failed', message }
    } finally {
      running.current = false
      if (mounted.current) setBusy(false)
      if (mounted.current && refreshAfterSave.current) {
        refreshAfterSave.current = false
        setLoadRevision((revision) => revision + 1)
      }
    }
  }
  const save = (next: ExecutionCatalog) => persist(() => call('save-catalog', { catalog: next }))
  const update = (id: string, patch: Partial<CombinationDefinition>) => {
    if (!catalog) return
    const target = catalog.combinations.find((item) => item.id === id)
    if (!target) return
    void save({
      ...catalog,
      combinations: catalog.combinations.map((item) =>
        item.id === id
          ? {
              ...item,
              ...patch,
              generated: false,
              autoEnabled: false,
              autoEnabledDisabled: true,
              ...(patch.isDefault === undefined
                ? {}
                : { defaultDisabled: patch.isDefault !== true }),
            }
          : patch.isDefault &&
              item.isDefault &&
              modelRefKey(item.modelRef) === modelRefKey(target.modelRef)
            ? { ...item, isDefault: false, defaultDisabled: true }
            : item,
      ),
    })
  }
  const add = async () => {
    if (!catalog) return
    const model = catalog.models.find((item) => modelRefKey(item.ref) === draft.model)
    if (!model) return
    if (
      !catalog.supportedPairings?.some(
        (item) =>
          modelRefKey(item.modelRef) === draft.model && item.harnessRefs.includes(draft.harness),
      )
    ) {
      setNotice(tRef.current('catalogSelectPairingFirst'))
      return
    }
    const chosen = { modelRef: model.ref, harnessRef: draft.harness }
    const policies = pairingPermissionPolicies(catalog, draft.model, draft.harness)
    const permissionPolicy = policies.includes(draft.permissionPolicy)
      ? draft.permissionPolicy
      : defaultPermissionPolicy(policies)
    if (!permissionPolicy) {
      setNotice(tRef.current('catalogNoPermissionPolicies'))
      return
    }
    if (
      [...catalog.combinations, ...(catalog.recommendations ?? [])].some(
        (item) => pairingKey(item) === pairingKey(chosen),
      )
    ) {
      setNotice(tRef.current('catalogAlreadyInList'))
      return
    }
    const makeDefault =
      isOfficialPairing(draft.harness, model.ref) &&
      !catalog.combinations.some(
        (item) => item.enabled && item.isDefault && modelRefKey(item.modelRef) === draft.model,
      )
    const result = await save({
      ...catalog,
      combinations: [
        ...catalog.combinations,
        {
          id: crypto.randomUUID(),
          name: `${displayModelName(model.ref, model.name)} + ${catalog.harnesses.find((item) => item.id === draft.harness)?.name ?? draft.harness}`,
          modelRef: model.ref,
          harnessRef: draft.harness,
          permissionPolicy,
          isDefault: makeDefault,
          enabled: true,
          autoEnabled: false,
          autoEnabledDisabled: true,
          defaultDisabled: !makeDefault,
        },
      ],
    })
    if (result.status === 'saved' && mounted.current)
      setDraft({ model: '', harness: 'dsh', permissionPolicy: 'workspace' })
  }
  const removeCombination = async (id: string) => {
    if (!catalog || !combinationChoices(catalog).some((row) => row.removableId === id)) return false
    const result = await persist(() => call('remove-combination', { id }))
    return result.status === 'saved'
  }
  const addRecommendations = async ({ selected, disabledIds }: CombinationSelection) => {
    if (!catalog) return
    const existing = new Set(catalog.combinations.map(pairingKey))
    const additions: CombinationDefinition[] = []
    for (const item of catalog.recommendations ?? []) {
      const key = pairingKey(item)
      if (!selected.has(recommendationChoiceKey(item)) || existing.has(key)) continue
      existing.add(key)
      additions.push({
        ...item,
        id: crypto.randomUUID(),
        permissionPolicy:
          defaultPermissionPolicy(
            pairingPermissionPolicies(catalog, modelRefKey(item.modelRef), item.harnessRef),
          ) ?? 'workspace',
        isDefault: false,
        enabled: true,
        autoEnabled: false,
        autoEnabledDisabled: true,
        defaultDisabled: true,
      })
    }
    const availableModels = new Set(
      catalog.models.filter((model) => model.available).map((model) => modelRefKey(model.ref)),
    )
    const combinations = catalog.combinations.map((item) => {
      const available = availableModels.has(modelRefKey(item.modelRef))
      if (!available && !disabledIds.has(item.id)) return item
      const key = savedChoiceKey(item.id)
      const enabled = available && selected.has(key)
      return item.enabled !== enabled
        ? {
            ...item,
            enabled,
            generated: false,
            autoEnabled: false,
            autoEnabledDisabled: true,
          }
        : item
    })
    if (
      additions.length ||
      combinations.some((item, index) => item !== catalog.combinations[index])
    )
      await save({ ...catalog, combinations: [...combinations, ...additions] })
  }
  return {
    catalog,
    availability,
    busy,
    notice,
    retry: () => {
      setNotice('')
      setLoadRevision((value) => value + 1)
    },
    draft,
    setDraft,
    editing,
    setEditing,
    update,
    add,
    addRecommendations,
    removeCombination,
  }
}
