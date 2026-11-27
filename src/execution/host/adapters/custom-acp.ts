import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { HarnessConfigurationError } from '../acp.ts'
import type { HarnessCapabilities } from '../../contracts/capabilities.ts'
import type { HarnessDefinition } from '../../contracts/catalog.ts'
import { executablePath, commandLaunch } from '../harness-registry.ts'
import { systemEnvironment } from './environment.ts'
import type { HarnessAdapter } from './types.ts'

/** Declared capabilities shared by user-registered standard ACP CLI engines. */
export const CUSTOM_ACP_CAPABILITIES: HarnessCapabilities = {
  transport: 'acp',
  authentication: 'official-account',
  protocols: [],
  customEndpoint: false,
  permissions: ['full-access'],
  sessionLoad: true,
  cancel: true,
  reasoning: 'cli-advertised',
  autoReview: 'unsupported',
}

/** Build a generic runtime adapter for an explicitly registered custom ACP engine. */
export function createCustomAcpAdapter(harness: HarnessDefinition): HarnessAdapter {
  return {
    id: harness.id,
    transport: 'acp',
    capabilities: CUSTOM_ACP_CAPABILITIES,
    matches: () => true,
    async available(_ctx, options) {
      const target = options.command || harness.command || ''
      const resolved = target ? await executablePath(target) : undefined
      return resolved
        ? { available: true }
        : {
            available: false,
            reason: `未找到自定义 ACP 程序（${target || harness.name}），请在执行引擎设置中检查路径`,
          }
    },
    async prepare(_ctx, record, options) {
      if (record.sandbox !== 'full-access')
        throw new HarnessConfigurationError(
          '自定义标准 ACP 引擎由外部 CLI 自主管理工具权限，仅支持显式授权的 full-access 权限。',
        )
      const target = options.command || harness.command || ''
      const resolved = target ? await executablePath(target) : undefined
      if (!resolved)
        throw new HarnessConfigurationError(
          `未找到自定义 ACP 程序（${target || harness.name}），无法启动此组合`,
        )
      const home = join(options.home, 'harnesses', 'custom', harness.id)
      await mkdir(home, { recursive: true, mode: 0o700 })
      const launch = commandLaunch(resolved, [...(options.prefix ?? harness.prefix ?? [])])
      return {
        home,
        command: launch.command,
        args: launch.args,
        env: systemEnvironment(),
        ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      }
    },
  }
}
