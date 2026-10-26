/** Huawei Chat Completions uses the official DSH pi-ai adapter and transcript replay. */
import { PiAiAdapter, type ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { InMemoryCredentialStore, type Model } from '@earendil-works/pi-ai'
import {
  stream,
  streamSimple,
  type OpenAICompletionsOptions,
} from '@earendil-works/pi-ai/api/openai-completions'
import { HUAWEI_MAAS_ENDPOINT } from '../../../credentials/contracts/huawei-maas.ts'

/** Only API-key auth is supported; no login or persistent pi-ai credential store is needed. */
export function createHuaweiNativeAdapter(readKey: () => Promise<string | undefined>) {
  const model: Model<'openai-completions'> = {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    provider: 'huawei-maas',
    api: 'openai-completions',
    baseUrl: HUAWEI_MAAS_ENDPOINT,
    input: ['text'],
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: 'high',
      xhigh: null,
      max: 'max',
    },
    contextWindow: 262144,
    maxTokens: 32768,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: { supportsDeveloperRole: false, supportsStore: false, supportsReasoningEffort: true },
  }
  const profile: ResolvedPiAiProviderProfile = {
    provider: 'huawei-maas',
    displayName: '华为云 MaaS',
    reasoning: 'high',
    streamIdleTimeoutMs: 90000,
    maxRequestImageBytes: 20 * 1024 * 1024,
    requestImagePixelBudget: 2048 * 2048,
    requestImageMaxBytes: 1024 * 1024,
    retryPolicy: resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'huawei-maas'),
    modelErrors: new Map(),
    configuredMaxTokens: new Map(),
    piProvider: {
      id: 'huawei-maas',
      name: '华为云 MaaS',
      baseUrl: HUAWEI_MAAS_ENDPOINT,
      auth: {
        apiKey: {
          name: '华为云 API Key',
          resolve: async () => {
            const apiKey = await readKey()
            return apiKey ? { auth: { apiKey }, source: 'windows-keyring' } : undefined
          },
        },
      },
      getModels: () => [model],
      stream: (value, context, options) => {
        if (value.api !== 'openai-completions') throw Error('华为云协议不匹配')
        return stream(
          value as Model<'openai-completions'>,
          context,
          options as OpenAICompletionsOptions | undefined,
        )
      },
      streamSimple: (value, context, options) => {
        if (value.api !== 'openai-completions') throw Error('华为云协议不匹配')
        return streamSimple(value as Model<'openai-completions'>, context, options)
      },
    },
  }
  const profiles = new Map([['huawei-maas', profile]])
  return new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: async () => {
      const key = await readKey()
      if (!key) throw new LlmError('请先配置华为云 API Key', 'MISSING_CREDENTIAL')
      return key
    },
    auth: {
      credentials: new InMemoryCredentialStore(),
      authContext: { env: async () => undefined, fileExists: async () => false },
    },
  })
}
