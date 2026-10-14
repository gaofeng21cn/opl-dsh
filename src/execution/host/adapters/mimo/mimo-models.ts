/**
 * The model surface this adapter is declared for, and the ACP config-option plumbing
 * used to pin it.
 *
 * The ids below express adaptation intent, not availability. Whether the model can
 * actually be reached is decided by the model-source plugin that owns the account, and
 * by the CLI's own advertisement at session time; neither is inferred from these
 * constants.
 */
import type { ModelRef } from '../../../contracts/catalog.ts'

/** Harness id; the adapter's `id`, and the key a source registers `supports` against. */
export const MIMO_CODE_HARNESS = 'mimo-code'
/** Provider id of the model source that owns this model's account and channels. */
export const MIMO_OFM_PROVIDER = 'our-free-model'
/** The single model this adapter declares for that provider. */
export const MIMO_OFM_MODEL = 'mimo-v2.6-flash-free'
/** Wire method that selects the model in this CLI. */
export const MIMO_SET_CONFIG_OPTION = 'session/set_config_option'
/** Config id the CLI advertises for model selection. */
export const MIMO_MODEL_OPTION = 'model'

/** The declared model, as a catalog entry the execution combination can bind. */
export const mimoCodeModels = (): readonly ModelRef[] => [
  { provider: MIMO_OFM_PROVIDER, model: MIMO_OFM_MODEL },
]

/** True only for the exact provider/model pair this adapter declares. */
export const isMimoCodeModel = (ref: ModelRef): boolean =>
  ref.provider === MIMO_OFM_PROVIDER && mimoCodeModels().some((item) => item.model === ref.model)

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** One advertised `select` option, reduced to the values this adapter compares. */
export interface MimoSelectOption {
  readonly currentValue: string
  readonly values: readonly string[]
}

/**
 * Read one `select` config option out of an advertised `configOptions` array.
 * Anything that is not a well-formed option is treated as absent, so a malformed or
 * unexpected advertisement fails the pinning checks instead of passing them.
 */
export function mimoConfigOption(configOptions: unknown, id: string): MimoSelectOption | undefined {
  if (!Array.isArray(configOptions)) return undefined
  for (const raw of configOptions) {
    const option = raw as Record<string, any> | null
    if (!option || typeof option !== 'object' || option.id !== id) continue
    const values = Array.isArray(option.options)
      ? option.options
          .map((entry: any) => text(entry?.value))
          .filter((value: string) => value.length > 0)
      : []
    return { currentValue: text(option.currentValue), values }
  }
  return undefined
}

/**
 * Check a pinned model against an advertisement.
 *
 * The exact value this suite constructed is compared, never a parsed or normalised
 * form: the CLI distinguishes a variant value from a base one by an extra path segment,
 * and an upstream model id may itself contain `/`. Exact comparison is the only check
 * that cannot accidentally accept a different model.
 *
 * @throws when the option is missing, the value is not offered, or the session
 * reports something other than the pinned value.
 */
export function assertMimoModelPinned(
  modelValue: string,
  configOptions: unknown,
  describe: (message: string) => Error,
): MimoSelectOption {
  const option = mimoConfigOption(configOptions, MIMO_MODEL_OPTION)
  if (!option) throw describe('当前会话未广告模型配置项，无法确认目标模型，已停止。')
  if (!option.values.includes(modelValue))
    throw describe(`官方 mimo 未广告要求的模型 ${modelValue}，已停止，不会改用其他模型。`)
  if (option.currentValue !== modelValue)
    throw describe(`会话当前模型与要求的 ${modelValue} 不一致，已停止，未发送任何任务。`)
  return option
}
