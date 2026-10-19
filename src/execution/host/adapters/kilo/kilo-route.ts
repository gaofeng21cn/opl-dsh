/**
 * Turn a resolved model-source route into the official CLI's own configuration.
 *
 * The route is owned by the model-source plugin and reaches this adapter only through
 * `options.modelSources.resolve`, which already rejects an incompatible protocol and a
 * source that was replaced or unloaded while the read was in flight. This module adds
 * nothing of its own: it serialises exactly what the source returned, refuses anything it
 * cannot express, and never repairs, rewrites, or substitutes an endpoint, a key, or a
 * model id.
 *
 * The configuration travels through `KILO_CONFIG_CONTENT`, the official variable the pinned
 * CLI reads from its own environment and merges as a document. Nothing is written into the
 * user's config files, and the key never reaches a log, an error, or a repository file.
 *
 * ## Routing entries carry no invented underlying model
 *
 * The provider declares exactly the bound model and no variants. For a routing entry such as
 * `kilo-auto/free` that means the CLI sends that id upstream unchanged and nothing else: no
 * concrete model is substituted, and no underlying target is recorded or inferred. The
 * pinned config-option value is the same id, so a read-back comparison stays exact.
 */
import type { ExternalModelRoute } from '../../model-sources.ts'
import { HarnessConfigurationError } from '../../acp.ts'
import { KILO_PROTOCOL } from './kilo-models.ts'

/**
 * Provider id used inside the CLI's own namespace, chosen to avoid user collisions.
 *
 * A dedicated namespace also keeps this suite's route separate from Kilo's own `kilo/*`
 * catalog. That separation is load-bearing rather than cosmetic: the measured CLI ships its
 * own `kilo/dots-studio/dots-3-note-preview:free`, `kilo/stealth/glyph-cluster` and
 * `kilo/kilo-auto/free` entries, and adding a source must never shadow, replace, or be
 * confused with them.
 */
export const KILO_ROUTE_PROVIDER_ID = 'oplkilo'
/**
 * The only wire protocol this suite bridges.
 *
 * Measured on the pinned binary: a custom route is driven through the OpenAI-compatible
 * Chat Completions client, which issues `POST {baseURL}/chat/completions` with
 * `stream: true`. The bundled Responses and Anthropic loaders build their own upstream
 * request shapes, so `responses` and `messages` are refused instead of approximated.
 */
export const KILO_SUPPORTED_PROTOCOLS = [KILO_PROTOCOL] as const
/** Bundled by the official CLI, so no provider SDK is fetched at launch time. */
const KILO_NPM = '@ai-sdk/openai-compatible'

/** The exact `model` config value the CLI must advertise and then report. */
export function kiloModelValue(model: string): string {
  return `${KILO_ROUTE_PROVIDER_ID}/${model}`
}

/**
 * Reject a route this suite cannot express exactly.
 *
 * `model` is the model the session record is bound to. A source that resolves a different
 * model is refused rather than followed: the record's model is the one the user chose, and
 * silently running another model is never acceptable.
 *
 * @throws when the protocol is unsupported, the model differs, or a field is unsafe.
 */
function assertExpressible(route: ExternalModelRoute, model: string): void {
  if (!KILO_SUPPORTED_PROTOCOLS.includes(route.protocol as 'chat'))
    throw new HarnessConfigurationError(
      `所选来源的协议（${route.protocol}）未被官方 Kilo 适配验证；官方仅为自定义端点打包了 OpenAI 兼容的 provider 适配器（Chat Completions），其余协议需要各自的服务端适配器，本套件未实现。已停止，未启动 Kilo，未猜测端点或模型。`,
    )
  if (route.model !== model)
    throw new HarnessConfigurationError(
      `模型来源返回的模型（${route.model}）与所选组合（${model}）不一致；已停止，未启动 Kilo，不会静默改用其他模型。`,
    )
  if (!model.trim() || /[\r\n\0]/.test(model))
    throw new HarnessConfigurationError('模型来源未提供可用的模型 ID，已停止，未启动 Kilo。')
  if (!route.apiKey.trim())
    throw new HarnessConfigurationError('模型来源未提供可用凭据，已停止，未启动 Kilo。')
  if (!route.baseURL.trim())
    throw new HarnessConfigurationError('模型来源未提供可用端点，已停止，未启动 Kilo。')
}

export interface KiloRouteConfig {
  /** Serialised configuration handed to the child through `KILO_CONFIG_CONTENT`. */
  readonly content: string
  /** The exact model value this configuration makes the CLI advertise. */
  readonly modelValue: string
  /** Never logged or echoed; exposed only so diagnostics can prove it was populated. */
  readonly hasKey: true
}

/**
 * Serialise one resolved route into the official CLI's configuration format.
 *
 * The provider declares exactly the bound model and no variants, so this namespace's model
 * option holds exactly one value and the pinned value is unambiguous — including when the
 * model id itself contains `/` or `:`. Every id this adapter declares was pinned and
 * read back unchanged by the pinned binary.
 *
 * @param route - the route the owning source resolved.
 * @param model - the model the session record is bound to; must match `route.model`.
 * @returns the configuration content and the model value it pins.
 */
export function buildKiloRouteConfig(route: ExternalModelRoute, model: string): KiloRouteConfig {
  assertExpressible(route, model)
  const modelValue = kiloModelValue(model)
  return {
    content: JSON.stringify({
      $schema: 'https://kilo.ai/schema.json',
      provider: {
        [KILO_ROUTE_PROVIDER_ID]: {
          npm: KILO_NPM,
          name: 'OPL Route',
          options: { baseURL: route.baseURL, apiKey: route.apiKey },
          models: {
            [model]: {
              name: model,
              ...(model === 'reflection/beam-free'
                ? { interleaved: { field: 'reasoning_content' } }
                : {}),
            },
          },
        },
      },
    }),
    modelValue,
    hasKey: true,
  }
}
