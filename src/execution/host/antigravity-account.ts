import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import type { AntigravityAccountStatus } from '../contracts/antigravity-account.ts'
import type { HarnessProxy } from '../contracts/catalog.ts'
import { AcpProcess, object } from './acp.ts'
import { systemEnvironment } from './adapters/environment.ts'
import { googleAccountLaunch } from './adapters/antigravity/google-launch.ts'
import { executablePath } from './harness-registry.ts'
import { harnessProxyEnvironment } from './proxy.ts'

type Route = {
  command?: string | undefined
  prefix?: readonly string[] | undefined
  proxy?: HarnessProxy | undefined
}
const execute = promisify(execFile)
const empty = (status: AntigravityAccountStatus['status']): AntigravityAccountStatus => ({
  status,
  models: [],
})

/** Read model slugs from the official tabular output. Display labels are not execution IDs. */
export function readAntigravityModels(stdout: string): Map<string, string> {
  const models = new Map<string, string>()
  for (const line of stdout.split(/\r?\n/)) {
    const row = /^\s*([a-z0-9]+(?:[._/-][a-z0-9]+)*)(?:\t+| {2,})(\S.*)$/.exec(line.trimEnd())
    if (row && row[1]!.length <= 128 && !models.has(row[1]!)) models.set(row[1]!, row[2]!.trim())
  }
  return models
}

function accountEnvironment(proxy: HarnessProxy | undefined) {
  return {
    ...harnessProxyEnvironment(systemEnvironment(), proxy),
    AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
  }
}

/** Only an explicit login request may initiate OAuth. Model discovery has no interactive fallback. */
export class AntigravityAccount {
  private catalog = empty('unknown')
  private routeKey: string | undefined
  private cache?: {
    key: string
    result: Promise<AntigravityAccountStatus>
    expires: number
    pending: boolean
  }
  private loginStart: Promise<AntigravityAccountStatus> | undefined
  private oauth: AcpProcess | undefined
  private closed = false
  private loginEpoch = 0

  constructor(
    private readonly getRoute: () => Promise<Route | undefined>,
    private readonly onModelsChanged?: () => void,
  ) {}

  /** Generic model catalogs use the last completed CLI read while discovery runs separately. */
  modelCatalog(): AntigravityAccountStatus {
    void this.status().catch(() => {})
    return this.catalog
  }

  updateRoute(route: Route | undefined) {
    const key = JSON.stringify([route?.command, route?.prefix, route?.proxy])
    if (this.routeKey !== key) {
      this.routeKey = key
      delete this.cache
      this.publishCatalog(empty('unknown'))
    }
    return key
  }

  private publishCatalog(next: AntigravityAccountStatus) {
    const previous = this.catalog
    this.catalog = next
    if (
      JSON.stringify([previous.models, previous.labels]) !==
      JSON.stringify([next.models, next.labels])
    )
      this.onModelsChanged?.()
  }

  async status(refresh = false): Promise<AntigravityAccountStatus> {
    if (this.oauth || this.loginStart) return empty('signing-in')
    if (this.closed) return empty('unavailable')
    const route = await this.getRoute()
    if (this.oauth || this.loginStart) return empty('signing-in')
    if (this.closed) return empty('unavailable')
    const key = this.updateRoute(route)
    if (
      this.cache?.key === key &&
      (this.cache.pending || (!refresh && this.cache.expires > Date.now()))
    )
      return this.cache.result
    const result = this.inspect(route)
    const entry = (this.cache = {
      key,
      result,
      expires: Date.now() + 60_000,
      pending: true as boolean,
    })
    return result.then((next) => {
      entry.pending = false
      if (this.cache === entry && !this.closed) this.publishCatalog(next)
      return next
    })
  }

  private async inspect(route: Route | undefined): Promise<AntigravityAccountStatus> {
    try {
      const path = await executablePath(route?.command || 'agy', 'antigravity')
      if (!path || this.closed) return empty('unavailable')
      const launch = googleAccountLaunch(path, route?.prefix, ['models'])
      const { stdout } = await execute(launch.command, launch.args, {
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 256 * 1024,
        windowsHide: true,
        windowsVerbatimArguments: !!launch.windowsVerbatimArguments,
        cwd: homedir(),
        env: accountEnvironment(route?.proxy),
      })
      const models = readAntigravityModels(stdout)
      return models.size
        ? { status: 'ready', models: [...models.keys()], labels: Object.fromEntries(models) }
        : empty('unknown')
    } catch (error) {
      const { stdout, stderr } = error as { stdout?: string; stderr?: string }
      return empty(
        /Please sign in to view available models\./i.test(String(stdout) + String(stderr))
          ? 'signed-out'
          : 'unknown',
      )
    }
  }

  login(): Promise<AntigravityAccountStatus> {
    if (this.oauth) return Promise.resolve(empty('signing-in'))
    if (this.loginStart) return this.loginStart
    this.loginStart = this.beginLogin(++this.loginEpoch).finally(() => {
      this.loginStart = undefined
    })
    delete this.cache
    this.publishCatalog(empty('signing-in'))
    return this.loginStart
  }

  private async beginLogin(epoch: number): Promise<AntigravityAccountStatus> {
    const route = await this.getRoute()
    const path = await executablePath(route?.command || 'agy', 'antigravity')
    if (!path || this.closed || epoch !== this.loginEpoch) return empty('unavailable')
    const launch = googleAccountLaunch(path, route?.prefix, ['acp'])
    const acp = new AcpProcess(
      launch.command,
      launch.args,
      homedir(),
      accountEnvironment(route?.proxy),
      () => {},
      () => {},
      () => {},
      !!launch.windowsVerbatimArguments,
    )
    this.oauth = acp
    const finish = async () => {
      try {
        await acp.dispose()
      } finally {
        if (this.oauth === acp) this.oauth = undefined
        delete this.cache
      }
    }
    try {
      const init = object(
        await acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} }, 15_000),
      )
      if (this.closed || epoch !== this.loginEpoch) return empty('unavailable')
      if (
        init.protocolVersion !== 1 ||
        !Array.isArray(init.authMethods) ||
        !init.authMethods.some((method) => object(method).id === 'oauth-personal')
      ) {
        throw Error('此版本的 Antigravity CLI 未提供 Google 个人账号登录。')
      }
      void acp
        .request('authenticate', { methodId: 'oauth-personal' }, 600_000)
        .finally(finish)
        .catch(() => {})
      return empty('signing-in')
    } catch (error) {
      await finish()
      throw error
    }
  }

  /** End only the browser authorization owned by this settings service. */
  async cancel(): Promise<AntigravityAccountStatus> {
    ++this.loginEpoch
    const acp = this.oauth
    const starting = this.loginStart
    await acp?.dispose()
    await starting?.catch(() => {})
    if (acp === this.oauth) this.oauth = undefined
    delete this.cache
    return this.status(true)
  }

  async dispose(): Promise<void> {
    this.closed = true
    await this.oauth?.dispose()
  }
}
