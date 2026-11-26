import {
  ANTIGRAVITY_GOOGLE_PROVIDER,
  GATEWAY_ANTIGRAVITY_GEMINI_MODELS,
} from '../../shared/models.ts'
import type { ModelRef } from './catalog.ts'

/**
 * Vendor-owned model/harness pairings.
 *
 * This is product metadata shared by the Host resolver and the Client catalog UI.
 * A generic agent runner (OpenCode, Kilo, Pi) deliberately has an empty model list:
 * it can execute a model when the user explicitly pairs it, but it does not own an
 * official model catalog of its own.
 */
export interface OfficialHarness {
  readonly id: string
  readonly officialModels: readonly ModelRef[]
}

export const OFFICIAL_HARNESSES: readonly OfficialHarness[] = [
  {
    id: 'dsh',
    officialModels: [
      { provider: 'deepseek', model: '*' },
      { provider: 'deepseek-official', model: '*' },
      { provider: 'deepseek-account', model: '*' },
      { provider: 'opl-gateway', model: 'deepseek-flash' },
      { provider: 'our-free-model', model: 'amd/DeepSeek-V4.1-Flash' },
      { provider: 'our-free-model', model: 'amd/DeepSeek-V4-Flash' },
    ],
  },
  {
    id: 'grok-build',
    officialModels: [{ provider: 'opl-gateway', model: 'grok::grok-4.7' }],
  },
  {
    id: 'codex',
    officialModels: [
      { provider: 'opl-gateway', model: 'codex::gpt-*' },
      { provider: 'our-free-model', model: 'openai/gpt-oss-20b' },
    ],
  },
  {
    id: 'claude',
    officialModels: [
      { provider: 'opl-gateway', model: 'aws::claude-*' },
      { provider: 'opl-gateway', model: 'kiro::claude-*' },
      { provider: 'opl-gateway', model: 'claude::claude-*' },
    ],
  },
  {
    id: 'antigravity',
    officialModels: [
      { provider: ANTIGRAVITY_GOOGLE_PROVIDER, model: '*' },
      ...GATEWAY_ANTIGRAVITY_GEMINI_MODELS.map((id) => ({
        provider: 'opl-gateway',
        model: `gemini::${id}`,
      })),
    ],
  },
  {
    id: 'minimax-code',
    officialModels: [
      { provider: 'minimax-official', model: 'MiniMax-M3.1-Flash' },
      { provider: 'minimax-official', model: 'MiniMax-M3' },
    ],
  },
  { id: 'qwen-code', officialModels: [] },
  {
    id: 'kimi-code',
    officialModels: [
      { provider: 'our-free-model', model: 'moonshotai/kimi-k2.6' },
      { provider: 'our-free-model', model: 'moonshotai/kimi-k3' },
      { provider: 'our-free-model', model: 'moonshotai/kimi-k3.1-pro' },
    ],
  },
  { id: 'opencode', officialModels: [] },
  { id: 'pi', officialModels: [] },
  {
    id: 'vibe',
    officialModels: [{ provider: 'our-free-model', model: 'mistralai/mistral-large-4-1t-a52b' }],
  },
  { id: 'kilo', officialModels: [] },
]

const matchesModel = (pattern: ModelRef, ref: ModelRef): boolean => {
  if (pattern.provider !== ref.provider) return false
  if (pattern.model === '*') return true
  if (pattern.model.endsWith('*')) return ref.model.startsWith(pattern.model.slice(0, -1))
  return pattern.model === ref.model
}

/** The vendor that officially pairs a model, if one exists. */
export function officialHarnessFor(ref: ModelRef): string | undefined {
  return OFFICIAL_HARNESSES.find((item) =>
    item.officialModels.some((model) => matchesModel(model, ref)),
  )?.id
}

/** Whether this exact model and harness pair is vendor-owned. */
export function isOfficialPairing(harnessRef: string, ref: ModelRef): boolean {
  return officialHarnessFor(ref) === harnessRef
}
