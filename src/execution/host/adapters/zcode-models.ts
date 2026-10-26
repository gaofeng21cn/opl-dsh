import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

/** Huawei model identity is independent of the OPL Gateway account. */
export const HUAWEI_ZCODE_MODEL = { provider: 'huawei-maas', model: 'glm-5.2' } as const
export const HUAWEI_ZCODE_COMBINATION = 'zcode/glm-5.2'
export const HUAWEI_MODELS: { id: 'glm-5.2' | 'deepseek-v4-flash' | 'kimi-k2.6'; name: string }[] =
  [
    { id: 'glm-5.2', name: 'GLM-5.2' },
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    { id: 'kimi-k2.6', name: 'Kimi K2.6' },
  ]

/** Expose the model through the official picker; the ZCode combination owns execution. */
export class HuaweiZcodeModelAdapter extends LlmAdapter {
  constructor(
    private readonly models = () =>
      HUAWEI_MODELS as readonly { id: string; name: string }[] | undefined,
    private readonly native?: LlmAdapter,
  ) {
    super()
  }
  override providerInfo(provider: string) {
    return { id: provider, name: '华为云 MaaS' }
  }
  override async listModels(provider: string) {
    return (this.models() ?? []).map((model) => ({ provider, ...model }))
  }
  override async resolveModel(provider: string, model: string) {
    if (!(this.models() ?? []).some((item) => item.id === model))
      throw new LlmError('华为云未登记该模型', 'UNKNOWN_MODEL')
    if (model === 'deepseek-v4-flash' && this.native)
      return this.native.resolveModel(provider, model)
    return { provider, ...this.models()!.find((item) => item.id === model)! }
  }
  override async prepareCall(provider: string, model: string) {
    await this.resolveModel(provider, model)
    if (model === 'deepseek-v4-flash' && this.native)
      return this.native.prepareCall(provider, model)
    return {
      model: await this.resolveModel(provider, model),
      stream: (options: GenerateOptions) => {
        options.signal?.throwIfAborted()
        return this.stream(options)
      },
    }
  }
  async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new LlmError(
      '请选择该华为云模型对应的执行组合；不会改用其他渠道执行。',
      'ZCODE_COMBINATION_REQUIRED',
    )
  }
}
