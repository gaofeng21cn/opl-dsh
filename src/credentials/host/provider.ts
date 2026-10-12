/** Import a legacy Huawei key once; the official service owns all subsequent I/O. */
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { Context } from '@deepseek-ai/cordis'
import { huaweiMaaSKeyring } from './windows-keyring.ts'
import { HUAWEI_MAAS_CREDENTIAL_REF } from '../contracts/huawei-maas.ts'

/** Never overwrite an existing source, or revive a provider the user removed.
 * Retain the legacy OS entry for recovery by older profiles; it is not a fallback. */
export async function migrateHuaweiCredential(ctx: Context, eligible: boolean): Promise<boolean> {
  if (process.platform !== 'win32' || !eligible) return false
  try {
    if (await ctx.credentials.resolve(credentialRef(HUAWEI_MAAS_CREDENTIAL_REF))) return false
    const value = await huaweiMaaSKeyring.read()
    if (!value) return false
    await ctx.credentials.set(credentialRef(HUAWEI_MAAS_CREDENTIAL_REF), value)
    return true
  } catch {
    // OS/helper/provider diagnostics can contain secrets. Keep the original entry
    // and migration marker untouched so the next start can safely retry.
    throw new Error('华为云旧凭据迁移未完成，原凭据已保留，请重启后重试。')
  }
}
