/** Windows code-mode frontend shipped in the signed KimiCU plugin. */
import { statSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

export const WINCU_VERSION = '0.3.10'
export const WINCU_ACTIONS = [
  'list_apps',
  'list_windows',
  'list_available_apps',
  'get_window',
  'launch_app',
  'get_window_state',
  'activate_window',
  'click',
  'type_text',
  'press_key',
  'scroll',
  'set_value',
  'perform_secondary_action',
  'drag',
  'drag_path',
] as const
export type WinCuAction = (typeof WINCU_ACTIONS)[number]

/** Resolve the complete installed plugin; never treat the native Agent as an MCP executable. */
export function windowsKimiCuLaunch(env: NodeJS.ProcessEnv = process.env) {
  const root =
    env.OPL_KIMI_CU_WINDOWS_ROOT ??
    (env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Kimi Computer Use', 'opl', WINCU_VERSION) : '')
  if (!isAbsolute(root)) throw Error('WinCU 安装目录无效，请重新安装 Windows KimiCU 组件。')
  const plugin = join(root, 'plugin')
  const executable = join(plugin, 'runtime', 'node-repl.exe')
  const native = join(root, 'runtime', 'kimi-cu.exe')
  for (const file of [executable, native, join(plugin, 'public/node_modules/@kimi/cu/index.mjs')]) {
    try {
      if (!statSync(file).isFile()) throw Error(`不是文件：${file}`)
    } catch (error) {
      throw Error(`Windows KimiCU 组件无法读取：${file}；${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const manifest = JSON.parse(readFileSync(join(plugin, 'kimi.plugin.json'), 'utf8'))
  if (
    manifest.name !== 'kimi-cu-win' ||
    manifest.version !== WINCU_VERSION ||
    manifest.mcpServers?.win?.command !== './runtime/node-repl.exe'
  )
    throw Error('Windows KimiCU 插件版本或启动入口与已验证接口不符。')
  return {
    executable,
    args: [] as string[],
    cwd: plugin,
    env: { ...env, KIMI_CU_WINDOWS_EXE: native },
    codeMode: true,
  }
}

/** Serialize model arguments as data in one fixed official API call, never as executable source. */
export function windowsKimiCuCall(action: string, args: unknown) {
  if (!(WINCU_ACTIONS as readonly string[]).includes(action))
    throw Error(`Windows KimiCU 不支持动作：${action}`)
  if (!args || typeof args !== 'object' || Array.isArray(args))
    throw Error('Windows KimiCU 参数必须是对象。')
  return {
    name: 'js',
    arguments: {
      code: `var { kimiCU } = await import("@kimi/cu"); var result = await kimiCU[${JSON.stringify(action)}](${JSON.stringify(args)}); nodeRepl.write(result === undefined ? "操作已投递；请重新观察确认结果。" : JSON.stringify(result));`,
      timeout_ms: 30_000,
      title: `DSH ${action}`,
    },
  }
}
