import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { DSH_COMBINATION, GROK_COMBINATION, type HarnessCatalog } from './harness-types.ts'
import type { ExecutionCatalog } from './catalog-types.ts'
export type { ExecutionCatalog } from './catalog-types.ts'

export const defaultExecutionCatalog = (): ExecutionCatalog => ({
  connections: [
    { id: 'opl-gateway', name: 'OPL Gateway', kind: 'opl-gateway', endpoint: 'https://gateway.medopl.com/v1', authRef: 'managed' },
    { id: 'deepseek-official', name: 'DeepSeek 官方', kind: 'deepseek-official', authRef: 'DSH 官方凭据' },
  ],
  models: [
    { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', modelId: 'deepseek-flash', connectionId: 'opl-gateway', protocol: 'messages' },
    { id: 'grok-4.7', name: 'Grok 4.7', modelId: 'grok-4.7', connectionId: 'opl-gateway', protocol: 'responses' },
  ],
  harnesses: [
    { id: 'dsh', name: 'DSH', kind: 'dsh', adapter: 'native-session' },
    { id: 'grok-build', name: 'Grok Build', kind: 'grok-build', adapter: 'acp-v1' },
  ],
  combinations: [
    { id: DSH_COMBINATION, name: 'DeepSeek + DSH', modelId: 'deepseek-flash', harnessId: 'dsh', connectionId: 'opl-gateway', sandbox: 'workspace', isDefault: true, enabled: true },
    { id: GROK_COMBINATION, name: 'Grok + Grok Build', modelId: 'grok-4.7', harnessId: 'grok-build', connectionId: 'opl-gateway', sandbox: 'workspace', isDefault: false, enabled: true },
  ],
})

const clone = <T,>(value: T): T => structuredClone(value)
const text = (value: unknown, field: string, max = 200): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw Error(`执行目录的 ${field} 无效`)
  return value.trim()
}
const validate = (value: unknown): ExecutionCatalog => {
  if (!value || typeof value !== 'object') throw Error('执行目录格式无效')
  const input = value as Partial<ExecutionCatalog>
  if (!Array.isArray(input.connections) || !Array.isArray(input.models) || !Array.isArray(input.harnesses) || !Array.isArray(input.combinations)) throw Error('执行目录缺少必要分组')
  const ids = new Set<string>()
  const unique = (id: string) => { if (ids.has(id)) throw Error(`执行目录存在重复 ID：${id}`); ids.add(id) }
  const connections = input.connections.map(raw => { const x = raw as any; const id = text(x.id, 'connection.id'); unique(`connection:${id}`); return { id, name: text(x.name, 'connection.name'), kind: x.kind, ...(typeof x.endpoint === 'string' && x.endpoint ? { endpoint: x.endpoint } : {}), ...(typeof x.authRef === 'string' && x.authRef ? { authRef: x.authRef } : {}) } })
  const connectionIds = new Set(connections.map(x => x.id))
  const models = input.models.map(raw => { const x = raw as any; const id = text(x.id, 'model.id'); unique(`model:${id}`); if (!connectionIds.has(x.connectionId)) throw Error(`模型 ${id} 的连接不存在`); return { id, name: text(x.name, 'model.name'), modelId: text(x.modelId, 'model.modelId'), connectionId: x.connectionId, protocol: x.protocol } })
  const modelIds = new Set(models.map(x => x.id))
  const harnesses = input.harnesses.map(raw => { const x = raw as any; const id = text(x.id, 'harness.id'); unique(`harness:${id}`); return { id, name: text(x.name, 'harness.name'), kind: x.kind, ...(typeof x.command === 'string' && x.command ? { command: x.command } : {}), ...(typeof x.adapter === 'string' && x.adapter ? { adapter: x.adapter } : {}) } })
  const harnessIds = new Set(harnesses.map(x => x.id))
  const combinations = input.combinations.map(raw => { const x = raw as any; const id = text(x.id, 'combination.id'); unique(`combination:${id}`); if (!modelIds.has(x.modelId) || !harnessIds.has(x.harnessId) || !connectionIds.has(x.connectionId)) throw Error(`组合 ${id} 引用不存在的模型、Harness 或连接`); if (!['read-only','workspace'].includes(x.sandbox)) throw Error(`组合 ${id} 的权限边界无效`); return { id, name: text(x.name, 'combination.name'), modelId: x.modelId, harnessId: x.harnessId, connectionId: x.connectionId, sandbox: x.sandbox, isDefault: x.isDefault === true, enabled: x.enabled !== false } })
  if (!combinations.some(x => x.isDefault && x.enabled)) throw Error('至少需要一个启用的默认组合')
  return { connections, models, harnesses, combinations }
}

export class ExecutionCatalogStore {
  readonly filename: string
  private value: ExecutionCatalog = defaultExecutionCatalog()
  private ready: Promise<void>
  private writeQueue: Promise<void> = Promise.resolve()
  constructor(home = dshHomePath()) { this.filename = join(home, 'profiles/desktop/execution-catalog.json'); this.ready = this.load() }
  private async load() { try { this.value = validate(JSON.parse(await readFile(this.filename, 'utf8'))) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw Error(`执行目录无法读取，原文件已保留：${error instanceof Error ? error.message : String(error)}`) } }
  async get(): Promise<ExecutionCatalog> { await this.ready; return clone(this.value) }
  async set(value: unknown): Promise<ExecutionCatalog> { await this.ready; const next = validate(value); const bytes = JSON.stringify(next, null, 2) + '\n'; const operation = this.writeQueue.then(async () => { await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 }); const temp = `${this.filename}.${randomUUID()}`; await writeFile(temp, bytes, { mode: 0o600 }); await rename(temp, this.filename); this.value = next }); this.writeQueue = operation.catch(() => {}); await operation; return clone(next) }
  async dispose() { await this.writeQueue }
}

export function catalogView(catalog: ExecutionCatalog, availability: Map<string, { available: boolean; reason?: string }>): HarnessCatalog['combinations'] {
  return catalog.combinations.filter(x => x.enabled).map(x => {
    const model = catalog.models.find(y => y.id === x.modelId)!
    const harness = catalog.harnesses.find(y => y.id === x.harnessId)!
    const status = availability.get(x.id) ?? { available: false, reason: '尚未安装对应 Harness 适配器' }
    return { id: x.id, name: x.name, model: model.name, modelId: model.modelId, harness: harness.name, available: status.available, ...(status.reason ? { reason: status.reason } : {}) }
  })
}
