import { ANTIGRAVITY_GOOGLE_PROVIDER } from '../../../shared/models.ts'
import type { ModelRef } from '../../contracts/catalog.ts'
import { dshAdapter } from './dsh.ts'
import { grokAdapter } from './grok.ts'
import { codexAdapter } from './codex.ts'
import { claudeAdapter } from './claude.ts'
import { minimaxCodeAdapter, MINIMAX_CODE_HARNESS } from './minimax.ts'
import { withMinimaxPermissions } from './minimax-permissions.ts'
import { kimiCodeAdapter } from './kimi/index.ts'
import { openCodeAdapter } from './opencode/index.ts'
import { piAdapter } from './pi/index.ts'
import { kiloAdapter } from './kilo/index.ts'
import { vibeAdapter } from './vibe.ts'
import { antigravityAdapter, antigravityGoogleAdapter } from './antigravity/index.ts'
import { qwenCodeAdapter } from './qwen/index.ts'
import type { HarnessAdapter } from './types.ts'
import type { ExternalModelSources } from '../model-sources.ts'
import { officialHarnessFor } from '../../contracts/official-harnesses.ts'
import { officialOpenCodeModel, isHiddenOfmSelection } from '../ofm-source/selection-policy.ts'
import { OFM_PROVIDER, OFM_PROVIDERS } from '../ofm-source/provider.ts'
export const harnessAdapters: readonly HarnessAdapter[] = [
  codexAdapter,
  antigravityAdapter,
  qwenCodeAdapter,
  claudeAdapter,
  withMinimaxPermissions(minimaxCodeAdapter),
  kimiCodeAdapter,
  openCodeAdapter,
  piAdapter,
  kiloAdapter,
  vibeAdapter,
  grokAdapter,
  dshAdapter,
]
export function adapterFor(
  id: string,
  ref: ModelRef,
  sources?: ExternalModelSources,
): HarnessAdapter | undefined {
  if (ref.provider === ANTIGRAVITY_GOOGLE_PROVIDER)
    return id === antigravityGoogleAdapter.id && antigravityGoogleAdapter.matches(ref)
      ? antigravityGoogleAdapter
      : undefined
  return harnessAdapters.find(
    (adapter) =>
      adapter.id === id &&
      (adapter.matches(ref) || (adapter.capabilities.customEndpoint && sources?.supports(id, ref))),
  )
}
export function nativeHarnessMatches(id: string, ref: ModelRef): boolean {
  return (id === 'codex' || id === 'claude') && adapterFor(id, ref) !== undefined
}
/** Known channel-specific adapters override vendor pairing; arbitrary models stay manual. */
export function automaticHarness(ref: ModelRef): string | undefined {
  if (isHiddenOfmSelection(ref)) return undefined
  if (antigravityGoogleAdapter.matches(ref)) return antigravityGoogleAdapter.id
  if (antigravityAdapter.matches(ref)) return antigravityAdapter.id
  if (officialOpenCodeModel(ref) !== undefined) return 'opencode'
  if (
    ref.provider === OFM_PROVIDER &&
    [
      'deepseek-ai/deepseek-v4.1-flash',
      'amd/DeepSeek-V4.1-Flash',
      'amd/DeepSeek-V4-Flash',
    ].includes(ref.model)
  )
    return 'dsh'
  if (OFM_PROVIDERS.includes(ref.provider) || ref.provider === 'opl-gateway') {
    const recommended = [openCodeAdapter, piAdapter, kiloAdapter].find((adapter) =>
      adapter.matches(ref),
    )
    if (recommended) return recommended.id
  }
  return officialHarnessFor(ref)
}
export function defaultHarness(ref: ModelRef): string {
  return automaticHarness(ref) ?? 'dsh'
}
