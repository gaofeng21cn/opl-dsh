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
