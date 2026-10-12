import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { HarnessConfigurationError } from '../acp.ts'
import type { HarnessAdapter } from './types.ts'
import { HUAWEI_MAAS_CREDENTIAL_REF } from '../../../credentials/contracts/huawei-maas.ts'

/** ZCode plan is a tool policy, not a verifiable DSH filesystem sandbox. */
export function withZcodePermissions(adapter: HarnessAdapter): HarnessAdapter {
  return {
    ...adapter,
    async available(ctx, options) {
      const installation = await adapter.available(ctx, options)
      if (!installation.available) return installation
      const credential = await ctx.credentials.describe(credentialRef(HUAWEI_MAAS_CREDENTIAL_REF))
      if (!credential.configured)
        return {
          available: false,
          reason: '请在设置 → 模型供应商中添加或编辑华为云 MaaS，保存 API Key',
        }
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
