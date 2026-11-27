/** In-memory defaults and resolution helpers for OPL Gateway pi-ai channels. */
import type { Context } from '@deepseek-ai/cordis'
import type { PiAiModelProfile, PiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { GatewayGroupId } from '../contracts/groups.ts'
import type { ModelDraft } from '../contracts/models.ts'
import { gatewayInferenceBaseURL } from './protocol.ts'

export type GatewayPiAiGroupId = Exclude<GatewayGroupId, 'deepseek'>

export interface GatewayChannelProfile extends Omit<PiAiProviderProfile, 'models'> {
  models?: ModelDraft[]
}

const GPT_STANDARD_EFFORTS = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
} as const

const CLAUDE_STANDARD_EFFORTS = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
} as const

export const DEFAULT_GATEWAY_CHANNELS: Readonly<Record<GatewayPiAiGroupId, GatewayChannelProfile>> =
  {
    codex: {
      displayName: 'OPL Gateway · Codex',
      api: 'openai-responses',
      baseURL: gatewayInferenceBaseURL('openai-responses'),
      apiKeyEnv: 'OPL_GATEWAY_CODEX_API_KEY',
      models: [
        {
          id: 'deepseek-flash',
          name: 'DeepSeek-V4.1-Flash',
          contextWindow: 1_000_000,
          input: ['text', 'image'],
          reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'xhigh' },
        },
        {
          id: 'gpt-6.2-astra',
          name: 'GPT-6.2 Astra',
          input: ['text', 'image'],
          reasoningEfforts: { ...GPT_STANDARD_EFFORTS },
        },
        {
          id: 'gpt-6.2-sol',
          name: 'GPT-6.2 Sol',
          input: ['text', 'image'],
          reasoningEfforts: { ...GPT_STANDARD_EFFORTS },
        },
        {
          id: 'gpt-6-luna',
          name: 'GPT-6 Luna',
          input: ['text', 'image'],
          reasoningEfforts: { ...GPT_STANDARD_EFFORTS },
        },
      ],
    },
    aws: {
      displayName: 'OPL Gateway · AWS',
      api: 'anthropic-messages',
      baseURL: gatewayInferenceBaseURL('anthropic-messages'),
      apiKeyEnv: 'OPL_GATEWAY_AWS_API_KEY',
      models: [
        {
          id: 'claude-opus-5-5',
          name: 'Claude Opus 5.5',
          input: ['text', 'image'],
          compat: { forceAdaptiveThinking: true },
          reasoningEfforts: { ...CLAUDE_STANDARD_EFFORTS },
        },
      ],
    },
    kiro: {
      displayName: 'OPL Gateway · Kiro',
      api: 'anthropic-messages',
      baseURL: gatewayInferenceBaseURL('anthropic-messages'),
      apiKeyEnv: 'OPL_GATEWAY_KIRO_API_KEY',
      models: [
        {
          id: 'claude-opus-5-5',
          name: 'Claude Opus 5.5',
          input: ['text', 'image'],
          compat: { forceAdaptiveThinking: true },
          reasoningEfforts: { ...CLAUDE_STANDARD_EFFORTS },
        },
      ],
    },
    claude: {
      displayName: 'OPL Gateway · Claude',
      api: 'anthropic-messages',
      baseURL: gatewayInferenceBaseURL('anthropic-messages'),
      apiKeyEnv: 'OPL_GATEWAY_CLAUDE_API_KEY',
      models: [
        {
          id: 'claude-opus-5-5',
          name: 'Claude Opus 5.5',
          input: ['text', 'image'],
          compat: { forceAdaptiveThinking: true },
          reasoningEfforts: { ...CLAUDE_STANDARD_EFFORTS },
        },
        {
          id: 'claude-fable-5-2',
          name: 'Claude Fable 5.2',
          input: ['text', 'image'],
          compat: { forceAdaptiveThinking: true },
          reasoningEfforts: { ...CLAUDE_STANDARD_EFFORTS },
        },
      ],
    },
    grok: {
      displayName: 'OPL Gateway · Grok',
      api: 'openai-responses',
      baseURL: gatewayInferenceBaseURL('openai-responses'),
      apiKeyEnv: 'OPL_GATEWAY_GROK_API_KEY',
      models: [
        {
          id: 'grok-4.7',
          name: 'Grok 4.7',
          input: ['text', 'image'],
          contextWindow: 500_000,
          reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' },
        },
      ],
    },
    gemini: {
      displayName: 'OPL Gateway · Gemini',
      api: 'openai-completions',
      baseURL: gatewayInferenceBaseURL('openai-completions'),
      apiKeyEnv: 'OPL_GATEWAY_GEMINI_API_KEY',
      models: [
        {
          id: 'gemini-4-carbon',
          name: 'Gemini 4 Carbon',
          input: ['text', 'image'],
        },
        {
          id: 'gemini-4-hydrogen',
          name: 'Gemini 4 Hydrogen',
          input: ['text', 'image'],
        },
      ],
    },
  }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export type SettingsDescriptorList = ReturnType<Context['settings']['describe']>

function suiteValueFrom(
  source: Context | SettingsDescriptorList | Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!source) return undefined
  if (Array.isArray(source)) {
    const suite = (source as SettingsDescriptorList).find((item) => item.ns === 'opl-suite')
    return isRecord(suite?.value) ? suite.value : undefined
  }
  if (typeof (source as Context).get === 'function') {
    const suite = (source as Context)
      .get('settings')
      ?.describe()
      .find((item) => item.ns === 'opl-suite')
    return isRecord(suite?.value) ? suite.value : undefined
  }
  return isRecord(source) ? (source as Record<string, unknown>) : undefined
}

/**
 * Resolve the effective connection and model list for one non-DeepSeek Gateway
 * channel by merging `opl-suite.gatewayChannels[groupId]` onto in-code defaults.
 * An explicit `models: []` saved by the user stays empty rather than falling back.
 */
export function resolveGatewayChannelProfile(
  source: Context | SettingsDescriptorList | Record<string, unknown> | undefined,
  groupId: GatewayPiAiGroupId,
): GatewayChannelProfile {
  const defaults = DEFAULT_GATEWAY_CHANNELS[groupId]
  const suiteValue = suiteValueFrom(source)
  const rawChannels = isRecord(suiteValue?.gatewayChannels) ? suiteValue.gatewayChannels : undefined
  const saved = isRecord(rawChannels?.[groupId])
    ? (rawChannels[groupId] as GatewayChannelProfile)
    : undefined
  if (!saved) return structuredClone(defaults)
  const savedDefaultInput = Array.isArray(saved.defaultInput) ? saved.defaultInput : undefined
  const { defaultInput: _ignoredDefaultInput, models: savedModels, ...savedRest } = saved
  const models = Array.isArray(savedModels)
    ? savedModels.map((entry) => {
        if (!isRecord(entry)) return entry as unknown as ModelDraft
        if (!Array.isArray(entry.input) || entry.input.length !== 0)
          return structuredClone(entry) as ModelDraft
        const { input: _implicitInput, ...declared } = entry
        return structuredClone(declared) as ModelDraft
      })
    : structuredClone(defaults.models ?? [])
  return {
    ...structuredClone(defaults),
    ...structuredClone(savedRest),
    ...(savedDefaultInput ? { defaultInput: [...savedDefaultInput] } : {}),
    models,
  }
}

const PI_AI_MODEL_FIELDS = new Set([
  'id',
  'name',
  'contextWindow',
  'maxTokens',
  'input',
  'reasoningEfforts',
  'compat',
])

const PI_AI_PROFILE_FIELDS = new Set([
  'apiKeyEnv',
  'displayName',
  'api',
  'baseURL',
  'modelOverrides',
  'compat',
  'defaultContextWindow',
  'defaultMaxTokens',
  'defaultInput',
  'headers',
  'reasoning',
  'thinkingBudgets',
  'cacheRetention',
  'transport',
  'timeoutMs',
  'websocketConnectTimeoutMs',
  'streamIdleTimeoutMs',
  'maxRequestImageBytes',
  'maxRequestImages',
  'imageOffloadCountQuantum',
  'requestImageBudgetCount',
  'requestImagePixelBudget',
  'requestImageMaxDimension',
  'requestImageMaxBytes',
  'retryPolicy',
])

/** Project a stored channel profile to the exact subset accepted by official `dsh-llm-pi-ai`. */
export function toPiAiProviderProfile(channel: GatewayChannelProfile): PiAiProviderProfile {
  const projected: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(channel)) {
    if (value !== undefined && PI_AI_PROFILE_FIELDS.has(key)) {
      projected[key] = structuredClone(value)
    }
  }
  if (Array.isArray(channel.models)) {
    projected.models = channel.models.map((entry) => {
      const clean: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(entry)) {
        if (value !== undefined && PI_AI_MODEL_FIELDS.has(key)) clean[key] = structuredClone(value)
      }
      return clean as unknown as PiAiModelProfile
    })
  }
  return projected as PiAiProviderProfile
}
