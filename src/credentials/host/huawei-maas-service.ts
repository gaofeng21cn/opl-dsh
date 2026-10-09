import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { KeyringError } from '../contracts/windows-keyring.ts'
import type { HuaweiMaaSKeyResult, HuaweiMaaSStatus } from '../contracts/huawei-maas.ts'
import {
  deleteHuaweiMaaSApiKey,
  describeHuaweiMaaSApiKey,
  setHuaweiMaaSApiKey,
} from './windows-keyring.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    oplHuaweiMaas: HuaweiMaaSService
  }
}

/** Local key configuration exposes presence and mutations, never a secret read. */
export class HuaweiMaaSService extends TypertRemoteService {
  static inject = ['typertGateway']

  constructor(ctx: Context) {
    super(ctx, 'oplHuaweiMaas')
  }

  /** Read connection metadata and Windows keyring availability. */
  @Remote('status')
  async status(): Promise<HuaweiMaaSStatus> {
    return {
      baseUrl: 'https://api.modelarts-maas.com/openai/v1',
      model: 'glm-5.2',
      credential: await describeHuaweiMaaSApiKey(),
    }
  }

  /** Save or replace the key in Windows Credential Manager; no file fallback.
   * @param key - The value submitted locally by the user.
   * @returns Safe presence and failure information, without the submitted value.
   */
  @Remote('saveKey')
  async saveKey(key: string): Promise<HuaweiMaaSKeyResult> {
    try {
      if (typeof key !== 'string') throw new KeyringError('invalid-value', 'Invalid key')
      await setHuaweiMaaSApiKey(key.trim())
    } catch (error) {
      return {
        ok: false,
        status: await this.status(),
        failure: error instanceof KeyringError ? error.code : 'helper-failed',
      }
    }
    return { ok: true, status: await this.status() }
  }

  /** Delete the suite's Huawei key; an absent key is already cleared.
   * @returns Safe presence and failure information.
   */
  @Remote('clearKey')
  async clearKey(): Promise<HuaweiMaaSKeyResult> {
    try {
      await deleteHuaweiMaaSApiKey()
    } catch (error) {
      return {
        ok: false,
        status: await this.status(),
        failure: error instanceof KeyringError ? error.code : 'helper-failed',
      }
    }
    return { ok: true, status: await this.status() }
  }
}
