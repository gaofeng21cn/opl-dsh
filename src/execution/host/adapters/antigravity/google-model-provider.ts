import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmError } from '../../../../shared/llm-error.ts'
import { displayModelName, displayModelSource } from '../../../../shared/models.ts'
import type { AntigravityAccountStatus } from '../../../contracts/antigravity-account.ts'

/** Project the signed-in CLI's model IDs into the official Session selector. */
export class AntigravityGoogleModels extends LlmAdapter {
  constructor(private readonly account: () => AntigravityAccountStatus) {
    super()
  }
  override providerInfo(provider: string) {
    return { id: provider, name: displayModelSource({ provider, model: '' }) }
  }
  override async listModels(provider: string) {
    const state = this.account()
    return state.status === 'ready'
      ? state.models.map((id) => ({
          provider,
          id,
          name: state.labels?.[id] || displayModelName({ provider, model: id }),
        }))
      : []
  }
  override async resolveModel(provider: string, model: string) {
    const selected = (await this.listModels(provider)).find((item) => item.id === model)
    if (!selected)
      throw new LlmError(
        'Antigravity 当前账号未提供所选模型，请在模型供应商中刷新账号状态。',
        'UNKNOWN_MODEL',
      )
    return selected
  }
  override async prepareCall(provider: string, model: string) {
    return {
      model: await this.resolveModel(provider, model),
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    throw new LlmError(
      '请使用 Antigravity CLI 组合运行 Google 账号模型。',
      'ANTIGRAVITY_COMBINATION_REQUIRED',
    )
  }
}
