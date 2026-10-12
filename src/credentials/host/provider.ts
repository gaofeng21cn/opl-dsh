/** A bounded adapter over the official credential seam, until it offers per-ref routing. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-credentials'
import { huaweiMaaSKeyring } from './windows-keyring.ts'
import { HUAWEI_MAAS_CREDENTIAL_REF } from '../contracts/huawei-maas.ts'
import { KeyringError } from '../contracts/windows-keyring.ts'

/** Retain the official provider and its storage/record APIs; route only one ref. */
export function installHuaweiCredentialRouting(ctx: Context): void {
  ctx.effect(() => {
    const owner = ctx.credentials
    const original = {
      resolve: owner.resolve,
      describe: owner.describe,
      set: owner.set,
      unset: owner.unset,
    }
    const notify = (ref: Parameters<typeof owner.set>[0]) => {
      void ctx.parallel('credentials/reference-updated', ref).catch(() => {
        ctx.logger.warn('Huawei credential observer failed after the OS write committed')
      })
    }
    const routes: typeof original = {
      async resolve(ref) {
        if (ref !== HUAWEI_MAAS_CREDENTIAL_REF) return original.resolve.call(owner, ref)
        const value = await huaweiMaaSKeyring.read()
        return value === undefined ? undefined : { value, source: 'windows-credential-manager' }
      },
      async describe(ref) {
        if (ref !== HUAWEI_MAAS_CREDENTIAL_REF) return original.describe.call(owner, ref)
        const info = await huaweiMaaSKeyring.describe()
        return {
          configured: info.configured,
          ...(info.configured ? { source: info.source } : {}),
          writable: info.supported && info.available,
        }
      },
      async set(ref, value) {
        if (ref !== HUAWEI_MAAS_CREDENTIAL_REF) return original.set.call(owner, ref, value)
        try {
          await huaweiMaaSKeyring.set(value.trim())
        } catch (error) {
          throw new KeyringError(
            error instanceof KeyringError ? error.code : 'helper-failed',
            '华为云 API Key 未写入 Windows 凭据管理器',
          )
        }
        notify(ref)
      },
      async unset(ref) {
        if (ref !== HUAWEI_MAAS_CREDENTIAL_REF) return original.unset.call(owner, ref)
        try {
          await huaweiMaaSKeyring.remove()
        } catch (error) {
          throw new KeyringError(
            error instanceof KeyringError ? error.code : 'helper-failed',
            '华为云 API Key 未从 Windows 凭据管理器删除',
          )
        }
        notify(ref)
      },
    }
    Object.assign(owner, routes)
    return () => {
      for (const key of ['resolve', 'describe', 'set', 'unset'] as const)
        if (owner[key] === routes[key]) Object.assign(owner, { [key]: original[key] })
    }
  })
}
