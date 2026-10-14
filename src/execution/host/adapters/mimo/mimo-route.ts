/**
 * Turn a resolved model-source route into the official CLI's own configuration.
 *
 * The route is owned by the model-source plugin and reaches this adapter only through
 * `options.modelSources.resolve`, which already rejects an incompatible protocol and a
 * source that was replaced or unloaded while the read was in flight. This module adds
 * nothing of its own: it serialises exactly what the source returned, refuses anything
 * it cannot express, and never repairs, rewrites, or substitutes an endpoint, a key, or
 * a model id.
 *
 * The configuration travels through `MIMOCODE_CONFIG_CONTENT`, which the CLI reads from
 * its own environment and merges as the highest-precedence `local` source. Nothing is
 * written into the user's config files, and the key never reaches a log, an error, or
 * a repository file.
 */
import type { ExternalModelRoute } from '../../model-sources.ts'
import { HarnessConfigurationError } from '../../acp.ts'

/** Provider id used inside the CLI's own namespace, chosen to avoid user collisions. */
export const MIMO_ROUTE_PROVIDER_ID = 'oplmimo'
/**
 * The only wire protocol this suite bridges.
 *
 * MiMo documents `@ai-sdk/openai-compatible` for OpenAI-compatible APIs and states that
 * any other wire protocol "requires their provider-specific adapter". That adapter is
 * not something this suite can verify, and the bundled `@ai-sdk/openai` /
 * `@ai-sdk/anthropic` loaders default to their own upstream request shapes rather than
 * to a verified route, so those protocols are refused instead of approximated.
 */
export const MIMO_SUPPORTED_PROTOCOLS = ['chat'] as const
/** Bundled by the official CLI, so no provider SDK is fetched at launch time. */
const MIMO_NPM = '@ai-sdk/openai-compatible'

/** The exact `model` config value the CLI must advertise and then report. */
export function mimoModelValue(model: string): string {
  return `${MIMO_ROUTE_PROVIDER_ID}/${model}`
}

/**
 * Reject a route this suite cannot express exactly.
 *
 * `model` is the model the session record is bound to. A source that resolves a
 * different model is refused rather than followed: the record's model is the one the
 * user chose, and silently running another model is never acceptable.
 *
 * @throws when the protocol is unsupported, the model differs, or a field is unsafe.
 */
function assertExpressible(route: ExternalModelRoute, model: string): void {
  if (!MIMO_SUPPORTED_PROTOCOLS.includes(route.protocol as 'chat'))
    throw new HarnessConfigurationError(
      `所选来源的协议（${route.protocol}）未被官方 MiMo Code 适配验证；官方仅记录了 OpenAI 兼容端点的 provider 适配器，其余协议需要各自的服务端适配器，本套件未实现。已停止，未启动 mimo，未猜测端点或模型。`,
    )
  if (route.model !== model)
    throw new HarnessConfigurationError(
      `模型来源返回的模型（${route.model}）与所选组合（${model}）不一致；已停止，未启动 mimo，不会静默改用其他模型。`,
    )
  if (!model.trim() || /[\r\n\0]/.test(model))
    throw new HarnessConfigurationError('模型来源未提供可用的模型 ID，已停止，未启动 mimo。')
  if (!route.apiKey.trim())
    throw new HarnessConfigurationError('模型来源未提供可用凭据，已停止，未启动 mimo。')
  if (!route.baseURL.trim())
    throw new HarnessConfigurationError('模型来源未提供可用端点，已停止，未启动 mimo。')
}

export interface MimoRouteConfig {
  /** Serialised configuration handed to the child through `MIMOCODE_CONFIG_CONTENT`. */
  readonly content: string
  /** The exact model value this configuration makes the CLI advertise. */
  readonly modelValue: string
  /** Never logged or echoed; exposed only so diagnostics can prove it was populated. */
  readonly hasKey: true
}

/**
 * Serialise one resolved route into the official CLI's configuration format.
 *
 * The provider declares exactly the bound model and no variants, so the CLI's model
 * option contains exactly one value for this provider and the pinned value is
 * unambiguous — including when the model id itself contains a `/`.
 *
 * @param route - the route the owning source resolved.
 * @param model - the model the session record is bound to; must match `route.model`.
 * @returns the configuration content and the model value it pins.
 */
export function buildMimoRouteConfig(route: ExternalModelRoute, model: string): MimoRouteConfig {
  assertExpressible(route, model)
  const modelValue = mimoModelValue(model)
  return {
    content: JSON.stringify({
      $schema: 'https://mimo.xiaomi.com/mimocode/config.json',
      model: modelValue,
      provider: {
        [MIMO_ROUTE_PROVIDER_ID]: {
          name: 'OPL Route',
          npm: MIMO_NPM,
          only_configured_models: true,
          models: { [model]: { name: model } },
          options: { baseURL: route.baseURL, apiKey: route.apiKey },
        },
      },
    }),
    modelValue,
    hasKey: true,
  }
}
