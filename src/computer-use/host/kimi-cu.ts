import process from 'node:process'
import os from 'node:os'

export const KIMI_CU_PLUGIN_URL =
  'https://cdn.kimi.com/kimi-computer-use-windows/latest/kimi-cu-win-plugin.zip'
export const KIMI_CU_INSTALL_COMMAND = `/plugins install ${KIMI_CU_PLUGIN_URL}`

export type KimiCuTool = never

export interface KimiCuQualification {
  supportedPlatform: boolean
  supportedArchitecture: boolean
  windowsVersionKnown: boolean
  supportedWindowsVersion: boolean
  pluginInstalled: boolean
  callable: false
  tools: readonly KimiCuTool[]
  status: 'unavailable' | 'eligible-but-no-protocol'
  reason: string
  installCommand: string
}

export interface KimiCuProbeOptions {
  platform?: NodeJS.Platform
  arch?: string
  windowsRelease?: string
  env?: NodeJS.ProcessEnv
}

/**
 * WinCU is intentionally fail-closed until Kimi publishes a stable DSH-callable
 * stdio/MCP process contract. This probe only reports host eligibility and the
 * presence of an installed plugin; it never starts a downloaded program.
 */
export function qualifyKimiCu(options: KimiCuProbeOptions = {}): KimiCuQualification {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const windowsRelease = options.windowsRelease ?? os.release()
  const supportedPlatform = platform === 'win32'
  const supportedArchitecture = arch === 'x64'
  const build = Number(windowsRelease.split('.')[2])
  const windowsVersionKnown = supportedPlatform && Number.isInteger(build) && build > 0
  const supportedWindowsVersion = windowsVersionKnown && build >= 18362
  // Kimi has not published a plugin installation path that DSH can safely probe.
  const pluginInstalled = false

  let reason = 'WinCU 没有公开可验证的 stdio/MCP 启动协议，DSH 不会调用它。'
  if (!supportedPlatform) reason = 'KimiCU WinCU 仅支持 Windows。'
  else if (!supportedArchitecture) reason = 'KimiCU WinCU 仅支持 x64 Windows。'
  else if (!supportedWindowsVersion) reason = '需要 Windows 10 1903 或更新版本（含 Windows 11）。'
  else if (!pluginInstalled) reason = '未检测到官方 Kimi Code WinCU 插件。'

  return {
    supportedPlatform,
    supportedArchitecture,
    windowsVersionKnown,
    supportedWindowsVersion,
    pluginInstalled,
    callable: false,
    tools: [],
    status:
      supportedPlatform && supportedArchitecture && pluginInstalled
        ? 'eligible-but-no-protocol'
        : 'unavailable',
    reason,
    installCommand: KIMI_CU_INSTALL_COMMAND,
  }
}

export function assertKimiCuPermission(allowed: boolean): void {
  if (!allowed) throw new Error('KimiCU WinCU requires explicit computer-use permission.')
}
