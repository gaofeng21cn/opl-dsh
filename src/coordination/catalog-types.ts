export type ConnectionKind = 'opl-gateway' | 'deepseek-official' | 'openai-compatible' | 'anthropic-compatible'
export interface ModelDefinition { id: string; name: string; modelId: string; connectionId: string; protocol: 'messages' | 'openai-completions' | 'responses' | 'anthropic-messages' }
export interface HarnessDefinition { id: string; name: string; kind: 'dsh' | 'grok-build' | 'acp'; command?: string; adapter?: string }
export interface CombinationDefinition { id: string; name: string; modelId: string; harnessId: string; connectionId: string; sandbox: 'read-only' | 'workspace'; isDefault: boolean; enabled: boolean }
export interface ExecutionCatalog { connections: { id: string; name: string; kind: ConnectionKind; endpoint?: string; authRef?: string }[]; models: ModelDefinition[]; harnesses: HarnessDefinition[]; combinations: CombinationDefinition[] }
