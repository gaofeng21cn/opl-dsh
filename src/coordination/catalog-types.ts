export type ConnectionKind = 'opl-gateway' | 'deepseek-official' | 'openai-compatible' | 'anthropic-compatible'
export type ModelProtocol = 'messages' | 'openai-completions' | 'responses' | 'anthropic-messages'
/** A transport/account route owned by a connection. It is implementation data, not a second model source. */
export interface ConnectionRoute { id: string; name: string; protocol: ModelProtocol; group?: string; internal?: boolean }
export interface ModelDefinition { id: string; name: string; modelId: string; connectionId: string; protocol: ModelProtocol; routeId?: string }
export interface HarnessDefinition { id: string; name: string; kind: 'dsh' | 'grok-build' | 'acp'; command?: string; adapter?: string }
export interface CombinationDefinition { id: string; name: string; modelId: string; harnessId: string; connectionId: string; sandbox: 'read-only' | 'workspace'; isDefault: boolean; enabled: boolean }
export interface ConnectionDefinition { id: string; name: string; kind: ConnectionKind; endpoint?: string; authRef?: string; routes?: ConnectionRoute[] }
export interface ExecutionCatalog { connections: ConnectionDefinition[]; models: ModelDefinition[]; harnesses: HarnessDefinition[]; combinations: CombinationDefinition[] }
