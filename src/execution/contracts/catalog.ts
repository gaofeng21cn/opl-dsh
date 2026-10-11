import type { ModelRef, ModelDefinition } from '../../shared/models.ts'
export * from '../../shared/models.ts'
/** Network routing for this external CLI and its children; omission inherits Desktop. */
export type HarnessProxy =
  | { mode: 'inherit' }
  | { mode: 'direct' }
  | { mode: 'custom'; url: string }
export interface HarnessDefinition {
  id: string
  name: string
  kind: 'dsh' | 'grok-build' | 'acp'
  command?: string
  /** Arguments preceding the official CLI subcommand, such as its installed bundle path. */
  prefix?: string[]
  adapter?: string
  proxy?: HarnessProxy
}
export interface CombinationDefinition {
  id: string
  name: string
  modelRef: ModelRef
  harnessRef: string
  generated?: boolean
  permissionPolicy: 'read-only' | 'workspace' | 'full-access'
  isDefault: boolean
  enabled: boolean
}
export interface ExecutionCatalog {
  version: 2
  models: ModelDefinition[]
  harnesses: HarnessDefinition[]
  combinations: CombinationDefinition[]
}
