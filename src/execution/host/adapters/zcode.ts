/** Official ZCode CLI adapter for the Huawei MaaS GLM route.
 *
 * Bind private bridge requests to the official Host credential owner. The bridge
 * resolves this one ref on demand over its existing stdio channel; launch arguments,
 * environment and ZCode configuration contain no model credential.
 */
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { mkdir } from 'node:fs/promises'
import { join, parse as parsePath } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { executablePath } from '../harness-registry.ts'
import type { HarnessSession } from '../../contracts/sessions.ts'
import type { AdapterOptions, AdapterLaunch, HarnessAdapter } from './types.ts'
import { systemEnvironment } from './environment.ts'
import { HUAWEI_MAAS_CREDENTIAL_REF } from '../../../credentials/contracts/huawei-maas.ts'
import {
  HUAWEI_MAAS_BASE_URL,
  HUAWEI_MAAS_MODEL,
  HUAWEI_MAAS_PROVIDER_ID,
  HUAWEI_DEFAULT_REASONING_LEVEL,
  huaweiReasoningLevel,
  ZCODE_FULL_ACCESS_MODE,
  ZCODE_HARNESS,
  HUAWEI_CREDENTIAL_REQUESTS,
} from './zcode-protocol.ts'

export {
  HUAWEI_MAAS_API_KEY_REF,
  HUAWEI_MAAS_BASE_URL,
  HUAWEI_MAAS_MODEL,
  HUAWEI_MAAS_PROVIDER_ID,
  ZCODE_HARNESS,
} from './zcode-protocol.ts'

/**
 * Map the authorized sandbox to an official ZCode session mode.
 *
 * `plan` is a tool policy and provides no operating-system filesystem confinement.
 * Restricted requests therefore fail before the CLI is launched.
 */
export function zcodeModeForSandbox(sandbox: string): string {
  if (sandbox === 'full-access') return ZCODE_FULL_ACCESS_MODE
  throw Error(`ZCode 组合仅支持已授权的 full-access，不支持「${sandbox}」隔离权限。`)
}

async function prepareZcodeLaunch(
  ctx: Context,
  record: HarnessSession,
  options: AdapterOptions,
): Promise<AdapterLaunch> {
  zcodeModeForSandbox(record.sandbox)
  const mode = record.zcodeMode ?? ZCODE_FULL_ACCESS_MODE
  // Fail loudly rather than falling back to the Codex bridge.
  const bridgePath = options.zcodeBridgePath
  if (!bridgePath) throw Error('未配置 ZCode 桥接器入口（AdapterOptions.zcodeBridgePath）')
  // The real runtime is `node <zcode.cjs> app-server --stdio`, so the command and the
  // prefix carrying the bundle path are resolved explicitly instead of assuming the CLI
  // is installed on PATH.
  const command = await executablePath(options.command || ZCODE_HARNESS)
  if (!command) throw Error('未找到官方 ZCode CLI')
  const home = join(options.home, 'harnesses', record.harnessRef, record.id)
  await mkdir(home, { recursive: true, mode: 0o700 })
  // Redirect the child's home and temp roots. The official runtime resolves its data
  // directory through `os.homedir()`, so isolating HOME/USERPROFILE is what keeps this
  // session away from the user's real `~/.zcode` and their stored account state. The
  // bridge reports its own resolved `os.homedir()` so the redirection can be checked.
  const profile = join(home, 'profile')
  const scratch = join(home, 'tmp')
  await mkdir(join(profile, '.config'), { recursive: true, mode: 0o700 })
  await mkdir(join(profile, '.cache'), { recursive: true, mode: 0o700 })
  await mkdir(join(profile, '.local', 'share'), { recursive: true, mode: 0o700 })
  await mkdir(scratch, { recursive: true, mode: 0o700 })
  const isolated = {
    HOME: profile,
    USERPROFILE: profile,
    HOMEDRIVE: parsePath(profile).root.replace(/[\/]+$/, ''),
    HOMEPATH: profile.slice(parsePath(profile).root.replace(/[\/]+$/, '').length),
    APPDATA: join(profile, '.config'),
    LOCALAPPDATA: join(profile, '.cache'),
    XDG_CONFIG_HOME: join(profile, '.config'),
    XDG_CACHE_HOME: join(profile, '.cache'),
    XDG_DATA_HOME: join(profile, '.local', 'share'),
    TEMP: scratch,
    TMP: scratch,
  }
  return {
    home,
    command: process.execPath,
    args: [bridgePath],
    clientRequests: new Map<string, () => Promise<unknown>>([
      [
        HUAWEI_CREDENTIAL_REQUESTS.describe,
        () => ctx.credentials.describe(credentialRef(HUAWEI_MAAS_CREDENTIAL_REF)),
      ],
      [
        HUAWEI_CREDENTIAL_REQUESTS.resolve,
        async () =>
          (await ctx.credentials.resolve(credentialRef(HUAWEI_MAAS_CREDENTIAL_REF)))?.value,
      ],
    ]),
    env: {
      ...systemEnvironment(),
      ELECTRON_RUN_AS_NODE: '1',
      OPL_ZCODE_COMMAND: command,
      OPL_ZCODE_PREFIX: JSON.stringify(options.prefix ?? []),
      OPL_ZCODE_MODEL: HUAWEI_MAAS_MODEL,
      OPL_ZCODE_PROVIDER_ID: HUAWEI_MAAS_PROVIDER_ID,
      // Both provider config paths are handed over as a pair; the bridge writes them
      // once the loopback relay port is known.
      OPL_ZCODE_PROVIDER_CONFIG_FILE: join(home, 'provider-builtin.json'),
      OPL_ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: join(home, 'provider-personal.json'),
      OPL_ZCODE_MODE: mode,
      OPL_ZCODE_REASONING_LEVEL: huaweiReasoningLevel(record.reasoningEffort),
      OPL_ZCODE_UPSTREAM: HUAWEI_MAAS_BASE_URL,
      ...isolated,
    },
  }
}

/** Harness id used by the host registry and the execution catalog. */
export const zcodeAdapter: HarnessAdapter = {
  id: ZCODE_HARNESS,
  transport: 'acp',
  capabilities: {
    transport: 'app-server',
    authentication: 'api-source',
    protocols: ['chat'],
    customEndpoint: false,
    permissions: ['full-access'],
    sessionLoad: true,
    cancel: true,
    reasoning: 'cli-advertised',
    autoReview: 'codex-auto-review',
  },
  matches: (ref) => ref.provider === HUAWEI_MAAS_PROVIDER_ID && ref.model === HUAWEI_MAAS_MODEL,
  available: (_ctx, options) =>
    executablePath(options.command || ZCODE_HARNESS).then((path) =>
      path
        ? { available: true }
        : { available: false, reason: '未找到官方 ZCode CLI，请在 Harness 页检查安装' },
    ),
  prepare: prepareZcodeLaunch,
  async configureSession(acp, record) {
    const value = huaweiReasoningLevel(record.reasoningEffort)
    const response = (await acp.request('session/set_config_option', {
      sessionId: record.acpSessionId,
      configId: 'reasoning_effort',
      value,
    })) as { configOptions?: { id: string; currentValue: string }[] }
    if (
      !response.configOptions?.some(
        (option) => option.id === 'reasoning_effort' && option.currentValue === value,
      )
    )
      throw Error('ZCode 未确认华为云推理档位，未发送请求')
    return { configOptions: response.configOptions }
  },
}
