import type { PendingCombination } from './pending-combination.ts'
import type { ModelCatalog, ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ExecutionCall } from '../../shared/client/remote-call.ts'
import { executionModelRef, executionModelRefKey } from '../../shared/models.ts'

type State = {
  current: ModelSelection | null
  groups: ModelCatalog['groups']
  retainedEffort?: string
  error?: string | null
  status?: string
}
type Store = { getSnapshot(): State; subscribe(listener: () => void): () => void }
type Directory = {
  store: Store
  load(): Promise<State>
  select(value: ModelSelection): Promise<unknown>
}
type Owner = { directoryFor(id: string): Directory }
type Reasoning = NonNullable<State['groups'][number]['models'][number]['reasoning']>
type EffortView = { key: string; external: boolean; reasoning?: Reasoning; effort?: string }

/** Project the active Harness into the official, per-Session model picker and /model command. */
export function installEffortDirectories(
  owner: Owner,
  call: ExecutionCall,
  changes: EventTarget,
  pendingCombination?: PendingCombination,
) {
  const original = owner.directoryFor
  const entries = new WeakMap<Directory, Directory>()
  const confirmed = new Map<string, { revision: number; until: number; levels: string[] }>()
  let disposed = false
  function directoryFor(this: Owner, id: string) {
    const source = original.call(this, id)
    const existing = entries.get(source)
    if (existing) return existing
    let active: EffortView | undefined
    let retry = false
    let failure: string | undefined
    let generation = 0
    let pending: Promise<void> | undefined
    let route: string | undefined
    let last: State | undefined
    let projected: State | undefined
    let projectionView: EffortView | undefined
    const listeners = new Set<() => void>()
    const notify = () => {
      for (const listener of listeners) listener()
    }
    const keyOf = () => {
      const model = source.store.getSnapshot().current
      return model ? executionModelRefKey(model) : undefined
    }
    const read = (force = false) => {
      const key = keyOf()
      if (!force && route === key && (pending || (active && !retry))) return pending
      failure = undefined
      retry = false
      route = key
      const epoch = ++generation
      active = undefined
      if (!key || disposed) return
      const current = () => !disposed && generation === epoch && key === keyOf()
      const task = (async () => {
        const selection = await call('model-selection', { sessionId: id })
        if (!current() || !selection.current || executionModelRefKey(selection.current) !== key)
          return
        const ref = executionModelRef(selection.current)
        const external = selection.effortSource === 'harness' && !!selection.combination
        let reasoning = selection.groups
          .find((g) => g.id === ref.provider)
          ?.models.find((m) => m.id === ref.model)?.reasoning
        let effort: string | undefined = selection.current.reasoningEffort
        if (external) {
          const registered = selection.registeredEfforts
          const cached = registered && confirmed.get(key)
          const fresh =
            cached && cached.revision === registered?.revision && cached.until > Date.now()
          if (registered) {
            const ids = fresh ? cached.levels : registered.levels
            const value = effort && ids.includes(effort) ? effort : registered.defaultEffort
            reasoning =
              ids.length > 1
                ? ({
                    efforts: ids.map((id) => ({ id, name: id })),
                    ...(ids.includes(value) ? { defaultEffort: value } : {}),
                  } as Reasoning)
                : undefined
            active = {
              key,
              external,
              ...(reasoning ? { reasoning } : {}),
              ...(ids.includes(value) ? { effort: value } : {}),
            }
            notify()
            if (fresh) return
          }
          const probe = await call('reasoning-preflight', {
            sessionId: id,
            combination: selection.combination!,
          })
          if (!current()) return
          retry = probe.status === 'unavailable'
          const levels =
            probe.status === 'known'
              ? probe.efforts.filter(
                  (e) => e.id !== 'default' && (!registered || registered.levels.includes(e.id)),
                )
              : []
          const defaultEffort = probe.status === 'known' ? probe.currentEffort : undefined
          reasoning =
            levels.length > 1
              ? ({
                  efforts: levels,
                  ...(defaultEffort && levels.some((e) => e.id === defaultEffort)
                    ? { defaultEffort }
                    : {}),
                } as Reasoning)
              : undefined
          effort = levels.find((e) => e.id === effort)?.id ?? defaultEffort
          if (registered && probe.status === 'known')
            confirmed.set(key, {
              revision: registered.revision,
              until: Date.now() + 60_000,
              levels: levels.map((e) => e.id),
            })
        }
        active = {
          key,
          external,
          ...(reasoning ? { reasoning } : {}),
          ...(effort ? { effort } : {}),
        }
      })()
        .catch(() => {
          if (current() && active?.external) {
            active = { key, external: true }
            retry = true
          }
        })
        .finally(() => {
          if (generation === epoch) {
            pending = undefined
            notify()
          }
        })
      pending = task
      return task
    }
    const snapshot = (): State => {
      const state = source.store.getSnapshot()
      if (state === last && projectionView === active && projected) return projected
      last = state
      projectionView = active
      projected = state
      if (!state.current) return projected
      const ref = executionModelRef(state.current)
      const key = executionModelRefKey(ref)
      const group = state.groups.find(
        (g) => g.id === ref.provider && g.models.some((m) => m.id === ref.model),
      )
      if (!group) return state
      const view = active?.key === key ? active : undefined
      const current = { ...state.current, ...ref }
      const awaitingOwner = !view && ref.provider === 'our-free-model'
      if (awaitingOwner || view?.external) {
        delete current.reasoningEffort
        if (view?.effort && view.reasoning)
          current.reasoningEffort = view.effort as ModelSelection['reasoningEffort'] & string
      }
      projected = {
        ...state,
        current,
        groups:
          view || awaitingOwner
            ? state.groups.map((g) =>
                g !== group
                  ? g
                  : {
                      ...g,
                      models: g.models.map((m) => {
                        if (m.id !== ref.model) return m
                        if (view && !view.external && m.reasoning) return m
                        const { reasoning: _, ...plain } = m
                        return view?.reasoning ? { ...plain, reasoning: view.reasoning } : plain
                      }),
                    },
              )
            : state.groups,
      }
      if (view?.external || awaitingOwner) delete projected.retainedEffort
      if (failure) projected = { ...projected, status: 'error', error: failure }
      return projected
    }
    let unsubscribe: (() => void) | undefined
    const changed = () => {
      if (route !== keyOf()) void read()
      notify()
    }
    const rebound = () => {
      void read(true)
      notify()
    }
    const directory = Object.create(source) as Directory
    directory.store = {
      getSnapshot: snapshot,
      subscribe(listener) {
        listeners.add(listener)
        if (!unsubscribe) {
          unsubscribe = source.store.subscribe(changed)
          changes.addEventListener(id, rebound)
        }
        return () => {
          listeners.delete(listener)
          if (!listeners.size) {
            unsubscribe?.()
            unsubscribe = undefined
            changes.removeEventListener(id, rebound)
          }
        }
      },
    }
    directory.load = async () => {
      await source.load()
      void read()
      return snapshot()
    }
    const select = async (selection: ModelSelection) => {
      const key = executionModelRefKey(selection)
      const sameModel = key === keyOf()
      if (sameModel && (!active || pending)) await read()
      if (sameModel && key !== keyOf()) throw Error('模型选择已改变，请重新选择推理档位')
      if (sameModel && active?.external && active.key === key) {
        try {
          await call('select-effort', { sessionId: id, ...selection })
          await read(true)
          return
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error)
          last = undefined
          notify()
          throw error
        }
      }
      const result = await source.select(selection)
      if (route !== keyOf()) void read()
      return result
    }
    directory.select = (selection) =>
      pendingCombination
        ? pendingCombination.select(id, () => select(selection))
        : select(selection)
    entries.set(source, directory)
    return directory
  }
  const previous = Object.getOwnPropertyDescriptor(owner, 'directoryFor')
  Object.defineProperty(owner, 'directoryFor', {
    configurable: true,
    writable: true,
    value: directoryFor,
  })
  return () => {
    disposed = true
    confirmed.clear()
    if (owner.directoryFor !== directoryFor) return
    if (previous) Object.defineProperty(owner, 'directoryFor', previous)
    else Reflect.deleteProperty(owner, 'directoryFor')
  }
}
