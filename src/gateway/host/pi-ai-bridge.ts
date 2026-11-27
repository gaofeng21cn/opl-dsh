/** Mount official `@deepseek-ai/dsh-llm-pi-ai` in an isolated Cordis scope for OPL Gateway channels. */
import { isDeepStrictEqual } from 'node:util'
import type { Context, VolatileSnapshot } from '@deepseek-ai/cordis'
import {
  LlmAdapter,
  LlmError,
  resolveRetryPolicy,
  type GenerateOptions,
  type LlmDiscoveredModel,
  type LlmModelDiscoveryRequest,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type LlmRuntime,
  type PreparedAdapterCall,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ImageAttachmentRef, ImageRequestTarget } from '@deepseek-ai/dsh-attachment'
import { contextOwner } from '../../compat/host/context-owner.ts'
import { GATEWAY_GROUPS } from '../contracts/groups.ts'
import { resolveGatewayChannelProfile, toPiAiProviderProfile } from './channel-defaults.ts'
import { DEFAULT_GATEWAY_RETRY_POLICY } from './config.ts'

export type GatewayPiAiDiscover = (
  request: LlmModelDiscoveryRequest,
  signal?: AbortSignal,
) => Promise<readonly LlmDiscoveredModel[]>

const discoverers = new WeakMap<object, GatewayPiAiDiscover>()

/** Return the isolated official discovery handler registered for this Gateway instance, if mounted. */
export function gatewayPiAiDiscover(ctx: Context): GatewayPiAiDiscover | undefined {
  return discoverers.get(contextOwner(ctx))
}

const UNINITIALIZED = Symbol('uninitialized')
const EMPTY_SENTINEL_PROVIDER = '__opl-gateway-empty-sentinel__'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

class IsolatedGatewayPiAiAdapter extends LlmAdapter {
  constructor(
    private readonly readInner: () => LlmAdapter | undefined,
    private readonly isEmptyChannel: (provider: string) => boolean,
  ) {
    super()
  }

  private inner(): LlmAdapter {
    const adapter = this.readInner()
    if (!adapter) throw new LlmError('OPL Gateway 模型适配器尚未就绪', 'NO_ADAPTER')
    return adapter
  }

  override providerInfo(provider: string): LlmProviderInfo {
    if (this.isEmptyChannel(provider)) return { id: provider, name: provider }
    return this.readInner()?.providerInfo(provider) ?? { id: provider, name: provider }
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    if (this.isEmptyChannel(provider)) return undefined
    return this.readInner()?.providerRetryPolicy(provider)
  }

  override imageRequestTarget(
    provider: string,
    model: string,
    image: ImageAttachmentRef,
  ): ImageRequestTarget {
    if (this.isEmptyChannel(provider))
      throw new LlmError(
        `pi-ai provider "${provider}" has no configured model "${model}"`,
        'UNKNOWN_MODEL',
      )
    return this.inner().imageRequestTarget(provider, model, image)
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    if (this.isEmptyChannel(provider)) return []
    return this.inner().listModels(provider)
  }

  override async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    if (this.isEmptyChannel(provider))
      throw new LlmError(
        `pi-ai provider "${provider}" has no configured model "${model}"`,
        'UNKNOWN_MODEL',
      )
    return this.inner().resolveModel(provider, model, signal)
  }

  override async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<PreparedAdapterCall> {
    if (this.isEmptyChannel(provider))
      throw new LlmError(
        `pi-ai provider "${provider}" has no configured model "${model}"`,
        'UNKNOWN_MODEL',
      )
    return this.inner().prepareCall(provider, model, signal)
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (this.isEmptyChannel(options.provider)) {
      return (async function* () {
        throw new LlmError(
          `pi-ai provider "${options.provider}" has no configured model "${options.model}"`,
          'UNKNOWN_MODEL',
        )
      })()
    }
    return this.inner().stream(options)
  }
}

export async function mountGatewayPiAiBridge(
  ctx: Context,
): Promise<{ adapter: LlmAdapter; discover: GatewayPiAiDiscover | undefined }> {
  const emptyProviders = new Set<string>()
  let lastRawChannels: unknown = UNINITIALIZED
  let lastProviders: Record<string, PiAiProviderProfile> = {}

  const readProviders = (): Record<string, PiAiProviderProfile> => {
    const suite = ctx
      .get('settings')
      ?.describe()
      .find((item) => item.ns === 'opl-suite')
    const rawChannels = isRecord(suite?.value) ? suite.value.gatewayChannels : undefined
    if (lastRawChannels !== UNINITIALIZED && isDeepStrictEqual(rawChannels, lastRawChannels)) {
      return lastProviders
    }
    lastRawChannels = rawChannels === undefined ? undefined : structuredClone(rawChannels)
    emptyProviders.clear()
    const next: Record<string, PiAiProviderProfile> = {}
    for (const group of GATEWAY_GROUPS) {
      if (group.id === 'deepseek') continue
      const channel = resolveGatewayChannelProfile(ctx, group.id)
      if (!channel.models?.length) {
        emptyProviders.add(group.provider)
        continue
      }
      next[group.provider] = toPiAiProviderProfile(channel)
    }
    // Keep at least one route during PiAi initialization if all 6 channels were emptied by the user.
    if (Object.keys(next).length === 0) {
      next[EMPTY_SENTINEL_PROVIDER] = {
        api: 'openai-completions',
        baseURL: 'https://invalid.local/v1',
        models: [{ id: '__empty__' }],
      }
    }
    lastProviders = next
    return next
  }

  let capturedAdapter: LlmAdapter | undefined
  let capturedDiscover: GatewayPiAiDiscover | undefined

  const makeHandle = (dispose: () => void) => Object.assign(dispose, { replace: () => {} })
  const llmSink = {
    registerAdapter(_providers: string[], adapter: LlmAdapter) {
      capturedAdapter = adapter
      return makeHandle(() => {
        if (capturedAdapter === adapter) capturedAdapter = undefined
      })
    },
    registerConfigurableProviders() {
      return makeHandle(() => {})
    },
    registerModelDiscovery(_ns: string, discover: GatewayPiAiDiscover) {
      capturedDiscover = discover
      return makeHandle(() => {
        if (capturedDiscover === discover) capturedDiscover = undefined
      })
    },
  }

  const isolated = ctx.isolate('llm').isolate('settings').isolate('authorization')
  await isolated.plugin({
    name: 'opl-gateway-pi-ai-host',
    async apply(scope) {
      scope.provide('llm', llmSink as unknown as LlmRuntime)
      await scope.plugin({
        name: 'opl-gateway-pi-ai',
        inject: ['llm'],
        apply(child) {
          PiAi.apply(child, {
            providers: {
              get: () =>
                readProviders() as unknown as VolatileSnapshot<Record<string, PiAiProviderProfile>>,
            },
          })
        },
      })
    },
  })

  if (capturedDiscover) {
    const owner = contextOwner(ctx)
    const discover = capturedDiscover
    discoverers.set(owner, discover)
    ctx.effect(() => () => {
      if (discoverers.get(owner) === discover) discoverers.delete(owner)
    })
  }

  // Warm the default profile snapshot so any immediate listModels/resolveModel finds all active channels.
  readProviders()
  const adapter = new IsolatedGatewayPiAiAdapter(
    () => {
      readProviders()
      return capturedAdapter
    },
    (provider) => {
      readProviders()
      return emptyProviders.has(provider)
    },
  )
  // Expose default gateway retry policy if PiAi hasn't materialized a matching route yet.
  const baseRetry = adapter.providerRetryPolicy.bind(adapter)
  const fallbackRetry = resolveRetryPolicy(DEFAULT_GATEWAY_RETRY_POLICY, 'llm-opl-gateway')
  adapter.providerRetryPolicy = (provider: string) => baseRetry(provider) ?? fallbackRetry
  return { adapter, discover: capturedDiscover }
}
