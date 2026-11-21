export interface EngineUpdateSettings {
  enabled: boolean
  mode: 'notify' | 'auto'
}
export interface EngineUpdateItem {
  id: string
  name: string
  current?: string
  target?: string
  status: 'available' | 'current' | 'unsupported' | 'failed' | 'installing' | 'waiting' | 'updated'
  message?: string
}
export interface EngineUpdateState extends EngineUpdateSettings {
  checking: boolean
  checkedAt?: string
  selectedIds?: string[]
  items: EngineUpdateItem[]
}
