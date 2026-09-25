/** OPL-owned credentials and dual-channel routing over official DSH adapters. */

import type { Context } from '@deepseek-ai/cordis'
import { assertUsableApiKey, LlmAdapter, LlmError, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type { LlmProviderInfo } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-attachment'
import { getOrCreateAnonymousUserId, type AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { DeepSeekAdapter, catalogModelInfo } from '@deepseek-ai/dsh-llm-deepseek'
import { resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek-api-key'
import type { ResolvedDeepSeekOptions } from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/dsh-settings'
import { OplGatewayAccountService } from './account-service.ts'
import { DualChannelAdapter, OPENAI_PROVIDER } from './dual-channel.ts'
import { Config, CODEX_API_KEY_REF, toAdapterConfig } from './config.ts'
import { OPL_GATEWAY_INFERENCE_BASE_URL } from './opl-credentials.ts'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  OPL_GATEWAY_SEARCH_DEFAULT_MAX_OUTPUT_TOKENS,
  OPL_GATEWAY_SEARCH_DEFAULT_MODEL,
  OPL_GATEWAY_SEARCH_DEFAULT_TIMEOUT_MS,
} from './search.ts'
import type { OplGatewaySearchProviderOptions } from './search.ts'
import { OplGatewaySearchProvider } from './search.ts'

export const name = 'llm-opl-gateway'
export const inject = ['llm']

export { Config, CODEX_API_KEY_REF, DEFAULT_API_KEY_REF, DEFAULT_MODELS, GROK_API_KEY_REF } from './config.ts'
export type { Config as OplGatewayConfig } from './config.ts'
export { OplGatewaySearchProvider } from './search.ts'
export type { OplGatewaySearchProviderOptions, OplSearchCitation, OplSearchStream } from './search.ts'
export {
  OPL_GATEWAY_SEARCH_DEFAULT_MAX_OUTPUT_TOKENS,
  OPL_GATEWAY_SEARCH_DEFAULT_MODEL,
  OPL_GATEWAY_SEARCH_DEFAULT_TIMEOUT_MS,
  OPL_GATEWAY_SEARCH_PROVIDER_ID,
} from './search.ts'
export { ADOPTION_RECORD_FILENAME, adoptOplGatewayKey, keyFingerprint, readAdoptedFingerprint, writeAdoptedFingerprint } from './adoption.ts'
export type { AdoptionOutcome } from './adoption.ts'
export {
  OPL_GATEWAY_ACCOUNT_SERVICE,
  OplGatewayAccountService,
} from './account-service.ts'
export type { GatewayAccountFacts, GatewayAccountPhase, GatewayAccountStatus, GatewaySignInResult } from './types.ts'
export {
  GatewayControlClient,
  GatewayControlError,
  OPL_GATEWAY_CONTROL_BASE_URL,
} from './gateway-control.ts'
export type { GatewayManagedKey, GatewayProfile, GatewaySession, GatewayUsage } from './gateway-control.ts'
export {
  FACTS_FILENAME,
  FACTS_FRESH_MS,
  SESSION_RECORD,
  clearFacts,
  clearSession,
  readFacts,
  readSession,
  writeFacts,
  writeSession,
} from './session-store.ts'
export {
  OPL_GATEWAY_INFERENCE_BASE_URL,
  OPL_GATEWAY_LEGACY_INFERENCE_BASE_URLS,
  importOplGatewayKey,
  readOplGatewayAccount,
  oplGatewayStateDirectories,
  oplGatewayStateDirectory,
  readBoundGatewayKey,
  resolveInferenceBaseURL,
  readOplGatewayBinding,
} from './opl-credentials.ts'
export type { OplGatewayAccount, OplGatewayKey } from './opl-credentials.ts'

const PROVIDER = 'opl-gateway'
const DISPLAY_NAME = 'OPL Gateway'

/**
 * The DeepSeek adapter names its route "DeepSeek" because that is the only
 * service it shipped for. This route reaches the same model through a
 * different account and endpoint, so the selector must not present the two as
 * one provider.
 */
class OplGatewayAdapter extends DeepSeekAdapter<ResolvedDeepSeekOptions> {
  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: DISPLAY_NAME }
  }
}

export function apply(ctx: Context, config: Config): void {
  const current = (): Config => config
  let lastRaw: Config | undefined
  let lastGood: ResolvedDeepSeekOptions | undefined

  const options = (): ResolvedDeepSeekOptions => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveAdapterOptions(toAdapterConfig(raw, OPL_GATEWAY_INFERENCE_BASE_URL), launchEnvironmentOf(ctx))
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      // Static composition resolves before anything registers, so this branch
      // only sees a live settings snapshot failing a beyond-schema bound:
      // keep serving the last good facts and say so once per bad snapshot.
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger.error('llm-opl-gateway: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return lastGood
    }
  }
  options()


  /**
   * Resolve one request's bearer token. The connection facts arrive from the
   * same snapshot that chose the endpoint, so a key can never be paired with
   * an endpoint from another generation.
   */
  const resolveApiKey = async (connection: ResolvedDeepSeekOptions): Promise<string> => {
    const ref = connection.apiKeyEnv
    const credentials = ctx.get('credentials')
    const stored = credentials === undefined
      ? launchEnvironmentOf(ctx).get(ref)?.value
      : (await credentials.resolve(ref))?.value
    if (stored !== undefined && stored.length > 0) {
      return assertUsableApiKey(stored, 'llm-opl-gateway', ref)
    }
    throw new LlmError(
      `llm-opl-gateway: no credential for provider route "${PROVIDER}"; sign in through Settings > OPL Gateway`
      + ` to configure ${ref}`,
      'MISSING_CREDENTIAL',
    )
  }

  let userId: AnonymousUserId | undefined
  const resolveUserId = (): AnonymousUserId => userId ??= getOrCreateAnonymousUserId()
  const adapter = new OplGatewayAdapter({
    options,
    resolveAuth: async connection => ({ headers: { 'x-api-key': await resolveApiKey(connection) } }),
    discoverModels: provider => Promise.resolve(options().models.map(model => catalogModelInfo(provider, model))),
    resolveUserId,
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments,
      hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath),
      ref,
    ),
    onReplayDegrade: ({ provider, model, reason }) => {
      ctx.logger.warn(`llm-opl-gateway: unusable Messages replay state on assistant history for route "${provider}/${model}"; sending provider-neutral content (${reason})`)
    },
    prepareExtensions: (request) => {
      const extensions = ctx.get('deepseekLlmApiExtensions')
      return extensions?.prepare(request)
        ?? Promise.resolve({ fields: {}, accept: () => Promise.resolve() })
    },
  })
  // Deliberately NOT registered as a configurable provider. This route is an
  // account, not an API-key profile: the operator signs in on the OPL Gateway
  // settings page, and its endpoint, protocol, and catalog are the plugin's
  // own facts rather than fields to fill in. Declaring it configurable would
  // add a Models-page row whose only content is "edit settings.yaml", which
  // reads as a broken twin of the official DeepSeek card. An undeclared live
  // route still reaches the model picker and still counts as a usable provider
  // for first-run readiness, so the surfaces that matter keep working.
  let activeChannel: 'deepseek' | 'codex' | 'grok' | undefined
  // The bundle configures the official pi-ai plugin's public OpenAI route.
  // Delegate through the public LLM service; no private adapter helpers are used.
  const compatibility = new class extends LlmAdapter {
    override async prepareCall(provider: string, model: string, signal?: AbortSignal) {
      return {
        model: await ctx.llm.resolveModelInfo(provider, model, signal),
        stream: (request: import('@deepseek-ai/dsh-llm').GenerateOptions) =>
          ctx.llm.stream({ ...request, provider }),
      }
    }
    stream(request: import('@deepseek-ai/dsh-llm').GenerateOptions) { return ctx.llm.stream(request) }
  }()
  const dualChannel = new DualChannelAdapter(adapter, compatibility,
    (channel) => { activeChannel = channel },
    (code) => { ctx.logger.warn(`OPL Gateway: Messages failed (${code}); retrying this request through the Codex OpenAI channel`) },
  )
  ctx.llm.registerAdapter([PROVIDER], dualChannel)
  ctx.on('llm/stream', async function* (request, next) {
    for await (const chunk of next()) {
      if (request.provider === OPENAI_PROVIDER) activeChannel = 'codex'
      yield chunk
    }
  })

  let account: OplGatewayAccountService | undefined
  ctx.inject(['credentials'], (credentialsCtx) => {
    const credentials = credentialsCtx.get('credentials')
    if (credentials === undefined) return
    // The Remote surface exists only where a credential store does: signing in
    // without one could not make the route usable.
    account ??= new OplGatewayAccountService(credentialsCtx, {
      credentialRef: () => options().apiKeyEnv,
      activeChannel: () => activeChannel,
      endpoint: () => options().baseURL,
      models: () => options().models.map(model => ({ id: model.id, name: model.name ?? model.id })),
    })
    void account.refresh().catch(() => { ctx.logger.warn('OPL Gateway account refresh failed') })
  })

  // Non-volatile Config is remounted by the Loader when its profile patch changes.
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })

  // Search uses the account's Codex-group credential; fetching stays in the
  // official HTTP provider. No separate preferences, Remote or accounting store.
  ctx.inject(['web'], (webCtx) => {
    const web = webCtx.get('web')
    if (web === undefined) return
    const apiKeyEnv = credentialRef(CODEX_API_KEY_REF)
    const provider = new OplGatewaySearchProvider((): OplGatewaySearchProviderOptions => ({
      apiKeyEnv,
      resolveApiKey: async () => {
        const credentials = webCtx.get('credentials')
        return credentials === undefined
          ? launchEnvironmentOf(webCtx).get(apiKeyEnv)?.value
          : (await credentials.resolve(apiKeyEnv))?.value
      },
      baseURL: options().baseURL,
      model: OPL_GATEWAY_SEARCH_DEFAULT_MODEL,
      maxOutputTokens: OPL_GATEWAY_SEARCH_DEFAULT_MAX_OUTPUT_TOKENS,
      timeoutMs: OPL_GATEWAY_SEARCH_DEFAULT_TIMEOUT_MS,
    }))
    webCtx.effect(() => web.registerSearchProvider(provider), 'llm-opl-gateway: web search')
  })
}
