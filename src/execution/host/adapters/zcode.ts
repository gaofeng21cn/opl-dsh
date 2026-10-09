/** Official ZCode CLI adapter for the Huawei MaaS GLM route.
 *
 * The adapter only prepares the launch. It deliberately does NOT read the Huawei
 * credential: `readHuaweiMaaSApiKey` is called by the bridge process, which holds the
 * value in memory only. Nothing here puts a secret into an environment variable, an
 * argument vector, a file or a log.
 */
import { mkdir } from 'node:fs/promises'
import { join, parse as parsePath } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { executablePath } from '../harness-registry.ts'
import type { HarnessSession } from '../../contracts/sessions.ts'
import type { AdapterOptions, AdapterLaunch, HarnessAdapter } from './types.ts'
import { systemEnvironment } from './environment.ts'
import {
  HUAWEI_MAAS_BASE_URL,
  HUAWEI_MAAS_MODEL,
  HUAWEI_MAAS_PROVIDER_ID,
  HUAWEI_DEFAULT_REASONING_LEVEL,
  ZCODE_FULL_ACCESS_MODE,
  ZCODE_HARNESS,
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
  _ctx: Context,
  record: HarnessSession,
  options: AdapterOptions,
): Promise<AdapterLaunch> {
  const mode = zcodeModeForSandbox(record.sandbox)
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
      OPL_ZCODE_REASONING_LEVEL: HUAWEI_DEFAULT_REASONING_LEVEL,
      OPL_ZCODE_UPSTREAM: HUAWEI_MAAS_BASE_URL,
      ...isolated,
    },
  }
}

/** Harness id used by the host registry and the execution catalog. */
export const zcodeAdapter: HarnessAdapter = {
  id: ZCODE_HARNESS,
  transport: 'acp',
  matches: (ref) => ref.provider === HUAWEI_MAAS_PROVIDER_ID && ref.model === HUAWEI_MAAS_MODEL,
  available: (_ctx, options) =>
    executablePath(options.command || ZCODE_HARNESS).then((path) =>
      path
        ? { available: true }
        : { available: false, reason: '未找到官方 ZCode CLI，请在 Harness 页检查安装' },
    ),
  prepare: prepareZcodeLaunch,
}
