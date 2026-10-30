import { mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname, join, parse as parsePath, resolve as resolvePath } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { executablePath } from '../../harness-registry.ts'
import { HarnessConfigurationError } from '../../acp.ts'
import { resolveGitBashPath } from '../../../../shell/host/git-bash.ts'
import type { HarnessSession } from '../../../contracts/sessions.ts'
import type { AdapterOptions, AdapterLaunch, HarnessAdapter } from '../types.ts'
import { systemEnvironment } from '../environment.ts'
import { ZCODE_FULL_ACCESS_MODE, ZCODE_HARNESS } from '../zcode-protocol.ts'
import {
  ZCODE_OFM_HARNESS,
  ZCODE_OFM_WIRE_PROTOCOL,
  assertOfmRoute,
  isZcodeOfmRef,
  zcodeOfmReasoningLevel,
} from './zcode-ofm-models.ts'

const exec = promisify(execFile)

/** OPL-owned bridge-only requests. No caller-selected credential ref is accepted. */
export const OFM_CREDENTIAL_REQUESTS = {
  describe: 'opl/ofm-credential/describe',
  resolve: 'opl/ofm-credential/resolve',
} as const

export function zcodeOfmBridgePath(moduleUrl: string = import.meta.url): string {
  const packaged = /\.m?js(?:[?#]|$)/.test(moduleUrl)
  return fileURLToPath(new URL(`./zcode-ofm-bridge${packaged ? '.mjs' : '.ts'}`, moduleUrl))
}

/**
 * Verify Git Bash can really start, before any credential is resolved.
 *
 * The official Bash provider silently degrades to `legacy-shell` (the system shell on
 * Windows) when it finds no Git Bash, so "no Git Bash" would otherwise look like a
 * successful run. This executes the resolved shell and checks its identity instead of
 * trusting its path, and refuses rather than accepting PowerShell, CMD, WSL or the
 * legacy fallback.
 *
 * Shell selection is deliberately kept separate from permission: this proves which
 * shell the child will run, while the sandbox mapping proves what the task authorized.
 */
export async function zcodeOfmBashEnvironment(
  env: NodeJS.ProcessEnv,
): Promise<{ env: NodeJS.ProcessEnv; shell: string }> {
  // Off Windows there is no Git Bash selection to make: the runtime uses the system
  // shell directly, so there is nothing to verify and nothing to pin.
  if (process.platform !== 'win32') return { env, shell: '' }
  let shell: string
  try {
    shell = resolveGitBashPath()
  } catch {
    throw new HarnessConfigurationError(
      'ZCode 组合未找到可运行的 Git Bash。请安装 Git for Windows，或将 OPL_GIT_BASH_PATH 指向 bash.exe；未启动 ZCode，未发送任务，不回退 PowerShell、CMD 或 WSL。',
    )
  }
  try {
    const result = await exec(
      shell,
      ['--noprofile', '--norc', '-c', 'printf "OPL_GIT_BASH:"; /usr/bin/uname -s'],
      { env, windowsHide: true, timeout: 5000, maxBuffer: 4096 },
    )
    if (!/^OPL_GIT_BASH:(?:MINGW(?:32|64)|MSYS)_NT-/.test(result.stdout.trim()))
      throw Error('Unexpected shell')
  } catch {
    throw new HarnessConfigurationError(
      'ZCode Git Bash 启动验证失败。请安装 Git for Windows 或将 OPL_GIT_BASH_PATH 指向可运行的 bash.exe；未启动 ZCode，未发送任务，不回退 PowerShell、CMD 或 WSL。',
    )
  }
  // `SHELL` and `GIT_EDITOR` are the two variables the official Git Bash provider itself
  // injects, so this matches the engine's own contract instead of adding one. The path
  // is *also* returned, because the authoritative pin is the protocol-level
  // `integratedTerminalShell` selection the bridge makes at session creation.
  return { env: { ...env, SHELL: shell, GIT_EDITOR: 'true' }, shell }
}

/**
 * Locate the official built-in provider release that ships inside the installed CLI.
 *
 * Verified against the real runtime: the CLI refuses to start unless this release is
 * available (`Bundled 与 Active ZCode Built-in Release 均不可用`), and an empty built-in
 * layer is not a substitute. The file is only ever referenced and read — never copied,
 * rewritten or replaced — so the installed release stays exactly as installed.
 *
 * @param command - the resolved official CLI executable.
 * @param prefix - arguments preceding the subcommand, typically the `zcode.cjs` bundle.
 * @returns the release path, or undefined when the layout is not recognized.
 */
export function officialBuiltinRelease(
  command: string,
  prefix: readonly string[] = [],
): string | undefined {
  const bundle = prefix.find((a) => a.toLowerCase().endsWith('.cjs'))
  const roots = new Set<string>()
  if (bundle) roots.add(dirname(resolvePath(bundle)))
  roots.add(dirname(resolvePath(command)))
  // The suite-managed layout keeps both under one install root: `ZCode.exe` beside
  // `resources/glm/zcode.cjs` and `resources/config/provider/zcode-builtin.json`.
  for (const root of [...roots]) {
    roots.add(dirname(root))
    roots.add(dirname(dirname(root)))
  }
  for (const root of roots) {
    const candidate = join(root, 'resources', 'config', 'provider', 'zcode-builtin.json')
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Isolate the child from the user's real ZCode profile and stored account state.
 *
 * Isolation uses the platform's own profile entry, not a `HOME` rewrite. On Windows the
 * official runtime resolves its data directory through `os.homedir()`, which Node
 * derives from `USERPROFILE`, so that variable alone carries the session away from the
 * real `%APPDATA%\ZCode` without pretending `HOME` is the isolation mechanism on a
 * platform that does not use it. `XDG_*` is set for the non-Windows runtimes that do
 * read it. `CODEX_HOME` is never touched: it belongs to another harness.
 *
 * The two provider config variables are the official dedicated profile entry and are
 * supplied by the caller, because the official runtime refuses a half-configured pair.
 */
async function isolateProfile(home: string): Promise<NodeJS.ProcessEnv> {
  const profile = join(home, 'profile')
  const scratch = join(home, 'tmp')
  await mkdir(join(profile, '.config'), { recursive: true, mode: 0o700 })
  await mkdir(join(profile, '.cache'), { recursive: true, mode: 0o700 })
  await mkdir(join(profile, '.local', 'share'), { recursive: true, mode: 0o700 })
  await mkdir(scratch, { recursive: true, mode: 0o700 })
  const drive = parsePath(profile).root.replace(/[/]+$/, '')
  return {
    // Windows profile entry. `HOME` is deliberately absent: redirecting it would be a
    // Linux-only mechanism asserted on Windows, and it is not how the official runtime
    // finds its data directory here.
    USERPROFILE: profile,
    HOMEDRIVE: drive,
    HOMEPATH: profile.slice(drive.length),
    APPDATA: join(profile, '.config'),
    LOCALAPPDATA: join(profile, '.cache'),
    XDG_CONFIG_HOME: join(profile, '.config'),
    XDG_CACHE_HOME: join(profile, '.cache'),
    XDG_DATA_HOME: join(profile, '.local', 'share'),
    TEMP: scratch,
    TMP: scratch,
  }
}

async function prepareZcodeOfmLaunch(
  _ctx: Context,
  record: HarnessSession,
  options: AdapterOptions,
): Promise<AdapterLaunch> {
  // Permission first and on its own: `plan` is a tool policy, not an operating-system
  // filesystem confinement, so a restricted request stops here rather than launching.
  if (record.sandbox !== 'full-access')
    throw new HarnessConfigurationError('ZCode 仅支持明确授权的 full-access')
  const mode = record.zcodeMode ?? ZCODE_FULL_ACCESS_MODE
  if (!isZcodeOfmRef(record.modelRef))
    throw new HarnessConfigurationError(
      `模型「${record.modelRef.provider}/${record.modelRef.model}」不属于 ZCode 的 Our Free Model 组合，已拒绝启动。`,
    )
  const reasoningLevel = zcodeOfmReasoningLevel(record.reasoningEffort)
  if (!reasoningLevel)
    throw new HarnessConfigurationError(
      `所选推理档位「${record.reasoningEffort}」不在这些模型官方声明的取值内，已停止；不会改用其他档位或其他模型。`,
    )
  // Shell second and on its own: proven before a credential is resolved.
  const bridgePath = zcodeOfmBridgePath()
  const command = await executablePath(options.command || ZCODE_HARNESS)
  if (!command) throw Error('未找到官方 ZCode CLI')
  // Located here, refused below. Probing the install layout before the first await keeps
  // this a pure lookup; whether it is acceptable is decided at the end, so an unload
  // during preparation is reported as an unload rather than being masked by it.
  const builtinRelease = officialBuiltinRelease(command, options.prefix ?? [])
  // Credentials belong to the source owner. Without an explicit registration there is
  // no route, and there is no second route to try.
  const sources = options.modelSources
  if (!sources) throw Error('未注册 Our Free Model 外部执行来源，已拒绝启动')
  if (!sources.supports(ZCODE_OFM_HARNESS, record.modelRef))
    throw Error('该模型来源尚未适配 ZCode，已拒绝启动')
  // Capture the registration that authorizes this launch *before* the first await.
  //
  // `resolve()` only re-checks the source once, immediately after its own read. This
  // route then performs several more awaits — home creation, profile directories, the
  // Git Bash qualification that executes a real shell — and the owner can unload or
  // replace its source during any of them. The lease covers registration lifetime and
  // declared pairing only; live catalog and connection freshness stay the owner's job,
  // and this route never treats a valid lease as proof that a model is still offered.
  const lease = sources.lease(ZCODE_OFM_HARNESS, record.modelRef)
  // Resolves and re-proves the pairing against the owner's live catalog, including the
  // re-check after the asynchronous connection read, so a source revoked late refuses.
  const route = assertOfmRoute(
    await sources.resolve(ZCODE_OFM_HARNESS, record.modelRef, ZCODE_OFM_WIRE_PROTOCOL),
    record.modelRef.model,
  )
  const home = join(options.home, 'harnesses', record.harnessRef, record.id)
  await mkdir(home, { recursive: true, mode: 0o700 })
  const isolated = await isolateProfile(home)
  const { env, shell } = await zcodeOfmBashEnvironment({
    ...systemEnvironment(),
    ...isolated,
  })
  // The final asynchronous preflight has completed. If the owner unloaded, replaced or
  // withdrew its pairing at any point since the lease was taken, there is no launch.
  lease.assertCurrent()
  // The official built-in release is referenced, never written. Without it the real CLI
  // exits before any session exists, so this is a hard precondition rather than a hint,
  // and it is refused only once every other preflight has already held.
  if (!builtinRelease)
    throw new HarnessConfigurationError(
      '未找到官方 ZCode 内置 Provider 配置（resources/config/provider/zcode-builtin.json）。请使用官方发行版安装的 ZCode；未启动 ZCode，未发送任务。',
    )
  return {
    home,
    command: process.execPath,
    args: [bridgePath],
    clientRequests: new Map<string, () => Promise<unknown>>([
      [
        OFM_CREDENTIAL_REQUESTS.describe,
        // Presence only; the value itself is never read for this answer.
        // `async` so a withdrawn registration always surfaces as a rejected promise
        // rather than a synchronous throw, which keeps one failure mode for the caller.
        async () => {
          lease.assertCurrent()
          return { configured: Boolean(route.apiKey), writable: false }
        },
      ],
      [
        OFM_CREDENTIAL_REQUESTS.resolve,
        // Held in this closure only. It reaches the bridge over private stdio and goes
        // no further than the loopback relay's Authorization header. The pinned
        // registration is re-checked here too: the bridge asks for the key while the
        // session is running, which can be long after preparation returned, and a
        // source revoked in that window must stop the read rather than serve a key the
        // owner has withdrawn.
        async () => {
          lease.assertCurrent()
          return route.apiKey
        },
      ],
    ]),
    env: {
      ...env,
      ELECTRON_RUN_AS_NODE: '1',
      OPL_ZCODE_OFM_COMMAND: command,
      OPL_ZCODE_OFM_PREFIX: JSON.stringify(options.prefix ?? []),
      OPL_ZCODE_OFM_MODEL: route.model,
      // The official release inside the installed CLI, referenced read-only.
      OPL_ZCODE_OFM_PROVIDER_CONFIG_FILE: builtinRelease,
      // The verified Git Bash path, pinned through `integratedTerminalShell`.
      OPL_ZCODE_OFM_GIT_BASH: shell,
      OPL_ZCODE_OFM_PERSONAL_PROVIDER_CONFIG_FILE: join(home, 'provider-personal.json'),
      OPL_ZCODE_OFM_MODE: mode,
      OPL_ZCODE_OFM_REASONING_LEVEL: reasoningLevel,
      OPL_ZCODE_OFM_UPSTREAM: route.baseURL,
    },
  }
}

export const zcodeOfmAdapter: HarnessAdapter = {
  id: ZCODE_OFM_HARNESS,
  transport: 'acp',
  capabilities: {
    transport: 'app-server',
    authentication: 'api-source',
    protocols: [ZCODE_OFM_WIRE_PROTOCOL],
    customEndpoint: true,
    permissions: ['full-access'],
    sessionLoad: true,
    cancel: true,
    // The levels come from the provider config this route declares, and the CLI of
    // record does not read the selected level back, so no runtime-advertised claim is
    // made here.
    reasoning: 'model-declared',
    autoReview: 'codex-auto-review',
  },
  matches: (ref) => isZcodeOfmRef(ref),
  // Installation only: `available` receives no model reference, so the pairing itself
  // is proven in `prepare`, where the exact model and its source are both known.
  available: (_ctx, options) =>
    executablePath(options.command || ZCODE_HARNESS).then((path) =>
      path
        ? { available: true }
        : { available: false, reason: '未找到官方 ZCode CLI，请在 Harness 页检查安装' },
    ),
  prepare: prepareZcodeOfmLaunch,
}

export { ZCODE_OFM_HARNESS, ZCODE_OFM_WIRE_PROTOCOL }
