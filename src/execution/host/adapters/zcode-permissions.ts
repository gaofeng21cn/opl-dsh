import { HarnessConfigurationError } from '../acp.ts'
import type { HarnessAdapter } from './types.ts'
import { describeHuaweiMaaSApiKey } from '../../../credentials/host/windows-keyring.ts'

/** ZCode plan is a tool policy, not a verifiable DSH filesystem sandbox. */
export function withZcodePermissions(adapter: HarnessAdapter): HarnessAdapter {
  return {
    ...adapter,
    async available(ctx, options) {
      const installation = await adapter.available(ctx, options)
      if (!installation.available) return installation
      const credential = await describeHuaweiMaaSApiKey()
      if (!credential.available) return { available: false, reason: 'Windows 凭据管理器不可用' }
      if (!credential.configured)
        return { available: false, reason: '请在设置 → 华为云 MaaS 保存 API Key' }
      return installation
    },
    async prepare(ctx, record, options) {
      if (record.sandbox !== 'full-access')
        throw new HarnessConfigurationError(
          'ZCode 仅支持明确授权的 full-access；plan 不提供操作系统只读隔离。',
        )
      return adapter.prepare!(ctx, record, options)
    },
  }
}
