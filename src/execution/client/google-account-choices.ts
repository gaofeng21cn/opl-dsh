import type { ModelCatalog, ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import { ANTIGRAVITY_GOOGLE_PROVIDER } from '../../shared/models.ts'

/** A tier is part of the route only when the CLI label and the exact ID agree. */
export function googleTier(id: string, label: string) {
  const match = /^(.*) \((Low|Medium|High|XHigh|Max|Minimal)\)$/i.exec(label)
  if (!match) return
  const level = match[2]!
  const suffix = '-' + level.toLowerCase()
  if (!id.endsWith(suffix)) return
  return { name: match[1]!, level, key: JSON.stringify([id.slice(0, -suffix.length), match[1]]) }
}

type Groups = ModelCatalog['groups']
type Entry = Groups[number]['models'][number]
export function googleChoices(groups: Groups, current: ModelSelection | null) {
  const choices = new Map<string, Map<string, string>>()
  const projected = groups.map((group) => {
    if (group.id !== ANTIGRAVITY_GOOGLE_PROVIDER) return group
    const families = new Map<string, Entry[]>()
    for (const model of group.models) {
      const tier = googleTier(model.id, model.name)
      if (tier) families.set(tier.key, [...(families.get(tier.key) ?? []), model])
    }
    const models = group.models.flatMap((model) => {
      const tier = googleTier(model.id, model.name)
      if (!tier) return [model]
      const family = families.get(tier.key)!
      if (family.length < 2) return [model]
      if (model !== family[0]) return []
      const representative =
        family.find((m) => current?.provider === group.id && m.id === current.model) ?? model
      const tiers = new Map(
        family.map((m) => [googleTier(m.id, m.name)!.level.toLowerCase(), m.id]),
      )
      choices.set(representative.id, tiers)
      const reasoning = {
        efforts: family.map((m) => {
          const name = googleTier(m.id, m.name)!.level
          return { id: name.toLowerCase(), name }
        }),
        defaultEffort: googleTier(representative.id, representative.name)!.level.toLowerCase(),
      } as NonNullable<Entry['reasoning']>
      return [{ ...representative, name: tier.name, reasoning }]
    })
    return { ...group, models }
  })
  return { groups: projected, choices }
}

type State = { current: ModelSelection | null; groups: Groups; retainedEffort?: string }
type Directory = {
  store: { getSnapshot(): State; subscribe(listener: () => void): () => void }
  load(): Promise<State>
  select(selection: ModelSelection): Promise<unknown>
}
type Owner = { directoryFor(sessionId: string): Directory }

/** Map tiers in the official model directory back to the CLI's exact advertised IDs. */
export function installGoogleAccountChoices(owner: Owner) {
  const original = owner.directoryFor
  const wrapped = new WeakMap<Directory, Directory>()
  function directoryFor(this: Owner, id: string): Directory {
    const source = original.call(this, id)
    const existing = wrapped.get(source)
    if (existing) return existing
    let last: State | undefined
    let result: State
    const project = (state: State) => {
      if (last === state) return result
      last = state
      if (!state.groups.some((group) => group.id === ANTIGRAVITY_GOOGLE_PROVIDER))
        return (result = state)
      const { choices, groups } = googleChoices(state.groups, state.current)
      result = { ...state, groups }
      if (
        state.current?.provider === ANTIGRAVITY_GOOGLE_PROVIDER &&
        choices.has(state.current.model)
      ) {
        const { reasoningEffort: _, ...current } = state.current
        result.current = current
        delete result.retainedEffort
      }
      return result
    }
    const directory: Directory = Object.create(source)
    directory.store = {
      getSnapshot: () => project(source.store.getSnapshot()),
      subscribe: (listener) => source.store.subscribe(listener),
    }
    directory.load = async () => project(await source.load())
    directory.select = async (selection) => {
      if (
        selection.provider === ANTIGRAVITY_GOOGLE_PROVIDER &&
        selection.reasoningEffort !== undefined
      ) {
        const state = source.store.getSnapshot()
        const family = googleChoices(state.groups, state.current).choices.get(selection.model)
        if (family) {
          const model = family.get(selection.reasoningEffort)
          if (!model) throw Error('所选模型档位已改变，请重新选择')
          if (state.current?.provider === selection.provider && state.current.model === model)
            return
          return source.select({ provider: selection.provider, model })
        }
      }
      return source.select(selection)
    }
    wrapped.set(source, directory)
    return directory
  }
  owner.directoryFor = directoryFor
  return () => {
    if (owner.directoryFor === directoryFor) owner.directoryFor = original
  }
}
