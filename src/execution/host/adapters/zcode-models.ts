import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

/** Huawei model identity is independent of the OPL Gateway account. */
export const HUAWEI_ZCODE_MODEL = { provider: 'huawei-maas', model: 'glm-5.2' } as const
export const HUAWEI_ZCODE_COMBINATION = 'zcode/glm-5.2'

/** Expose the model through the official picker; the ZCode combination owns execution. */
export class HuaweiZcodeModelAdapter extends LlmAdapter {
  override providerInfo(provider: string) {
    return { id: provider, name: '华为云 MaaS' }
  }
  override async listModels(provider: string) {
    return [{ provider, id: HUAWEI_ZCODE_MODEL.model, name: 'GLM-5.2' }]
  }
  override async resolveModel(provider: string, model: string) {
    if (model !== HUAWEI_ZCODE_MODEL.model)
      throw new LlmError('华为云 ZCode 组合不支持该模型', 'UNKNOWN_MODEL')
    return { provider, id: model, name: 'GLM-5.2' }
  }
  override async prepareCall(provider: string, model: string) {
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
      '请选择华为云 GLM-5.2 · ZCode 组合；不会改用其他渠道执行。',
      'ZCODE_COMBINATION_REQUIRED',
    )
  }
}
