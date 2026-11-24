import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import { displayModelName, executionModelRef } from '../../shared/models.ts'

/** Collapse only aliases also advertised by the logical Gateway. Independent routes keep their entries. */
export function projectGatewayModelCatalog(catalog: ModelCatalog): ModelCatalog {
  const parent = catalog.groups.find((group) => group.id === 'opl-gateway')
  if (!parent) return catalog
  const routes = new Set(parent.models.map((model) => model.id))
  const alias = (provider: string, model: string) => {
    const ref =
      provider === 'opl-gateway-auto-review' && model === 'codex-auto-review'
        ? { provider: parent.id, model: 'codex::codex-auto-review' }
        : executionModelRef({ provider, model })
    return provider !== parent.id && ref.provider === parent.id && routes.has(ref.model)
      ? ref
      : undefined
  }
  const groups = catalog.groups.flatMap((group) => {
    if (group === parent)
      return [
        {
          ...group,
          models: group.models.map((model) => ({
            ...model,
            name: displayModelName({ provider: group.id, model: model.id }, model.name),
          })),
        },
      ]
    const models = group.models.filter((model) => !alias(group.id, model.id))
    return models.length === group.models.length
      ? [group]
      : models.length
        ? [{ ...group, models }]
        : []
  })
  return {
    ...catalog,
    default: { ...catalog.default, ...alias(catalog.default.provider, catalog.default.model) },
    groups,
  }
}

/** Adapt the official catalog read for the lifetime of the Gateway plugin. */
export function installGatewayModelCatalogProjection(controller: {
  modelCatalog: () => Promise<ModelCatalog>
}): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(controller, 'modelCatalog')
  const original = controller.modelCatalog
  const projected = async function (this: typeof controller) {
    return projectGatewayModelCatalog(await original.call(this))
  }
  Object.defineProperty(controller, 'modelCatalog', {
    configurable: true,
    writable: true,
    value: projected,
  })
  return () => {
    if (Object.getOwnPropertyDescriptor(controller, 'modelCatalog')?.value !== projected) return
    if (descriptor) Object.defineProperty(controller, 'modelCatalog', descriptor)
    else Reflect.deleteProperty(controller, 'modelCatalog')
  }
}
