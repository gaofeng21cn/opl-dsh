/**
 * Native DSH model-catalog projection of the MiniMax Code models.
 *
 * `buildModelCatalog` and `modelAvailable` in the official session controller only read
 * `ctx.llm.listProviders()` / `listModels()`, so adding references to the execution
 * catalog alone would leave the models unselectable. Registering a real adapter through
 * the public `ctx.llm.registerAdapter` extension point is what makes `session/modelCatalog`,
 * `selectModel` and the `llm/stream` interception agree on the same models.
 *
 * The provider exposes no credential of its own: authentication belongs to the official
 * `mcode` CLI account. Each model advertises exactly the reasoning settings the CLI
 * honors for it, through the official `reasoning` schema, so a setting shown in the
 * picker is the setting the adapter later writes over `session/set_config_option`:
 *
 *  - M3.1 exposes the CLI's own `thinkingEffort` levels.
 *  - M3 exposes the thinking switch only; the CLI advertises no effort for it, so the
 *    catalog must not invent `low`/`high` style tiers that nothing would apply.
 */
import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelReasoningInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import {
  minimaxCodeCombinations,
  MINIMAX_CODE_HARNESS,
  MINIMAX_CODE_PROVIDER,
  type MinimaxCombination,
} from './minimax.ts'

export { MINIMAX_CODE_PROVIDER }

/**
 * Models the official CLI account serves. Requesting a model outside this list must
 * fail instead of reaching a provider that does not own it.
 */
const fixedModels = (): readonly MinimaxCombination[] => minimaxCodeCombinations()

/** Reasoning block advertised for one model, using the official schema. */
function reasoningOf(spec: MinimaxCombination): LlmModelReasoningInfo {
  return {
    efforts: spec.control.options.map((option) => ({
      id: ReasoningEffortId(option.id),
      name: option.name,
      ...(option.description ? { description: option.description } : {}),
    })),
    defaultEffort: ReasoningEffortId(spec.fallback),
  }
}

export class MiniMaxCodeModelAdapter extends LlmAdapter {
  override providerInfo(provider: string) {
    return { id: provider, name: 'MiniMax 官方账号（mcode）' }
  }

  override async listModels(provider: string) {
    return fixedModels().map((item) => ({
      provider,
      id: item.model,
      // The compact model name only. A reasoning tier belongs in the reasoning block,
      // never in a model's name, and the harness is added by the combination view.
      name: item.name,
      description: '由官方 MiniMax Code CLI 提供；登录与额度由官方账号决定。',
    }))
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const spec = fixedModels().find((item) => item.model === model)
    if (!spec) throw new LlmError('该模型不属于 MiniMax Code 的支持范围', 'UNKNOWN_MODEL')
    return { provider, id: model, name: spec.name, reasoning: reasoningOf(spec) }
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

  /**
   * Reached only when no MiniMax Code combination is bound to the session, which means
   * the request would otherwise be sent to a provider that cannot serve it.
   */
  async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new LlmError(
      `MiniMax 模型由官方 mcode 账号提供，请先选择固定组合「${fixedModels()
        .map((item) => item.name)
        .join('」或「')}」；本套件不会改用其他渠道执行。`,
      `${MINIMAX_CODE_HARNESS.toUpperCase().replace(/-/g, '_')}_COMBINATION_REQUIRED`,
    )
  }
}
