import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { oplProfilePath } from '../../shared/host/profile-paths.ts'
import type { HarnessInstallation } from '../contracts/installations.ts'
import type {
  EngineUpdateState,
  EngineUpdateSettings,
  EngineUpdateItem,
} from '../contracts/engine-updates.ts'

export class EngineUpdates {
  private state: EngineUpdateState = { enabled: true, mode: 'notify', checking: false, items: [] }
  private save = Promise.resolve()
  private plan = new Map<string, HarnessInstallation>()
  private waiting = new Map<string, boolean>()
  private running = new Map<string, Promise<void>>()
  private ready: Promise<void>
  private timer: NodeJS.Timeout
  private stopped = false
  private checkJob?: Promise<void>
  private nextCheck = 0
  constructor(
    home: string,
    private readonly ops: {
      list(): Promise<HarnessInstallation[]>
      probe(item: HarnessInstallation): Promise<EngineUpdateItem>
      busy(id: string): boolean
      install(item: HarnessInstallation, target: string): Promise<string>
      log(message: string): void
    },
  ) {
    this.file = oplProfilePath(home, 'engine-updates.json')
    this.ready = this.load()
    this.timer = setInterval(() => void this.tick().catch((e) => ops.log(String(e))), 30000)
    this.timer.unref()
  }
  private file: string
  private async load() {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8'))
      if (typeof raw.enabled !== 'boolean' || !['notify', 'auto'].includes(raw.mode))
        throw Error('执行引擎更新设置无效')
      this.state.enabled = raw.enabled
      this.state.mode = raw.mode
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.state.enabled = false
        this.ops.log(String(error))
      }
    }
  }
  async snapshot() {
    await this.ready
    return structuredClone(this.state)
  }
  async settings(value: EngineUpdateSettings) {
    await this.ready
    if (typeof value.enabled !== 'boolean' || !['auto', 'notify'].includes(value.mode))
      throw Error('更新设置无效')
    const write = this.save.then(async () => {
      await mkdir(dirname(this.file), { recursive: true })
      await writeFile(
        this.file + '.tmp',
        JSON.stringify({ enabled: value.enabled, mode: value.mode }),
      )
      await rename(this.file + '.tmp', this.file)
      Object.assign(this.state, { enabled: value.enabled, mode: value.mode })
      for (const [id, manual] of this.waiting)
        if (!manual && (!value.enabled || value.mode !== 'auto')) {
          this.waiting.delete(id)
          const row = this.state.items.find((i) => i.id === id)
          if (row) row.status = 'available'
        }
    })
    this.save = write.catch(() => {})
    await write
    await this.tick()
    return this.snapshot()
  }
  private async tick() {
    await this.ready
    if (this.stopped) return
    if (this.state.enabled && Date.now() >= this.nextCheck) await this.check()
    if (this.state.enabled && this.state.mode === 'auto')
      for (const row of this.state.items)
        if (row.status === 'available') this.waiting.set(row.id, this.waiting.get(row.id) ?? false)
    this.drain()
  }
  async check() {
    await this.ready
    if (this.stopped || this.checkJob || this.running.size || this.waiting.size)
      return this.snapshot()
    this.nextCheck = Date.now() + 6 * 3600000
    this.state.checking = true
    delete this.state.selectedIds
    this.checkJob = (async () => {
      const installed = (await this.ops.list()).filter((i) => i.installed)
      const results = await Promise.all(
        installed.map(async (item) => {
          try {
            return await this.ops.probe(item)
          } catch (e) {
            return {
              id: item.id,
              name: item.name,
              status: 'failed' as const,
              message: e instanceof Error ? e.message : String(e),
            }
          }
        }),
      )
      if (this.stopped) return
      this.plan = new Map(installed.map((i) => [i.id, i]))
      this.state.items = results
      this.state.checkedAt = new Date().toISOString()
      if (this.state.enabled && this.state.mode === 'auto')
        for (const r of results) if (r.status === 'available') this.waiting.set(r.id, false)
    })()
      .catch((e) => this.ops.log(String(e)))
      .finally(() => {
        this.state.checking = false
        delete this.checkJob
        this.drain()
      })
    return this.snapshot()
  }
  async install(ids: string[]) {
    await this.ready
    if (
      this.state.checking ||
      !Array.isArray(ids) ||
      !ids.length ||
      ids.some((id) => !this.state.items.some((r) => r.id === id && r.status === 'available'))
    )
      throw Error('可更新列表已改变，请重新检查')
    const prior = this.state.selectedIds ?? []
    const continuing = prior.some((id) => this.waiting.has(id) || this.running.has(id))
    this.state.selectedIds = [...new Set([...(continuing ? prior : []), ...ids])]
    for (const id of ids) this.waiting.set(id, true)
    this.drain()
    return this.snapshot()
  }
  private drain() {
    if (this.stopped || this.state.checking || this.running.size) return
    for (const [id] of this.waiting) {
      const row = this.state.items.find((r) => r.id === id),
        item = this.plan.get(id)
      if (!row?.target || !item) {
        this.waiting.delete(id)
        continue
      }
      if (this.ops.busy(id)) {
        row.status = 'waiting'
        continue
      }
      const target = row.target
      this.waiting.delete(id)
      row.status = 'installing'
      const job = Promise.resolve()
        .then(() => this.ops.install(item, target))
        .then((version) => {
          row.status = 'updated'
          row.current = version
        })
        .catch((e) => {
          row.status = 'failed'
          row.message = e instanceof Error ? e.message : String(e)
        })
        .finally(() => {
          this.running.delete(id)
          this.drain()
        })
      this.running.set(id, job)
      break
    }
  }
  lock(id: string) {
    return this.running.get(id)
  }
  get active() {
    return this.running.size > 0
  }
  async dispose() {
    this.stopped = true
    clearInterval(this.timer)
    await Promise.allSettled([
      ...this.running.values(),
      this.save,
      ...(this.checkJob ? [this.checkJob] : []),
    ])
  }
}
