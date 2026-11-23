/** Windows code-mode frontend shipped in the signed KimiCU plugin. */
import { discoverWindowsKimiCu } from '../../../installer/kimi-cu-windows.mjs'

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
  const installation = discoverWindowsKimiCu(env.OPL_SUITE_ROOT, env)
  if (!installation) throw Error('WinCU 安装目录无效，请重新安装 Windows KimiCU 组件。')
  const { executable, native, plugin } = installation
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
