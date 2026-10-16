import type { ModelRef } from '../../contracts/catalog.ts'
import { dshAdapter } from './dsh.ts'
import { grokAdapter } from './grok.ts'
import { codexAdapter } from './codex.ts'
import { claudeAdapter } from './claude.ts'
import { minimaxCodeAdapter, MINIMAX_CODE_HARNESS } from './minimax.ts'
import { withMinimaxPermissions } from './minimax-permissions.ts'
import { zcodeAdapter } from './zcode.ts'
import { withZcodePermissions } from './zcode-permissions.ts'
import { zcodeOfmAdapter } from './zcode-ofm/index.ts'
import { kimiCodeAdapter } from './kimi/index.ts'
import { mimoCodeAdapter } from './mimo/index.ts'
import { poolAdapter } from './pool/index.ts'
import { stepCodeAdapter } from './step/index.ts'
import { museCodeAdapter } from './muse/index.ts'
import { openCodeAdapter } from './opencode/index.ts'
import { piAdapter } from './pi/index.ts'
import { kiloAdapter } from './kilo/index.ts'
import type { HarnessAdapter } from './types.ts'
import type { ExternalModelSources } from '../model-sources.ts'
/**
 * Harnesses that own their own model catalog and authentication. An automatic
 * combination must bind one of these instead of the DSH loop, because DSH cannot
 * route a model that belongs to an external official CLI account.
 */
const externalHarnessIds: readonly string[] = [
  'codex',
  'claude',
  MINIMAX_CODE_HARNESS,
  'zcode',
  'kimi-code',
  'mimo-code',
  'pool',
  'step-code',
  'muse-code',
  'opencode',
  'pi',
  'kilo',
]
export const harnessAdapters: readonly HarnessAdapter[] = [
  codexAdapter,
  claudeAdapter,
  withMinimaxPermissions(minimaxCodeAdapter),
  withZcodePermissions(zcodeAdapter),
  zcodeOfmAdapter,
  kimiCodeAdapter,
  openCodeAdapter,
  mimoCodeAdapter,
  poolAdapter,
  stepCodeAdapter,
  museCodeAdapter,
  piAdapter,
  kiloAdapter,
  grokAdapter,
  dshAdapter,
]
export function adapterFor(
  id: string,
  ref: ModelRef,
  sources?: ExternalModelSources,
): HarnessAdapter | undefined {
  return harnessAdapters.find(
    (adapter) =>
      adapter.id === id &&
      (adapter.matches(ref) || (adapter.capabilities.customEndpoint && sources?.supports(id, ref))),
  )
}
export function nativeHarnessMatches(id: string, ref: ModelRef): boolean {
  return (id === 'codex' || id === 'claude') && adapterFor(id, ref) !== undefined
}
export function defaultHarness(ref: ModelRef): string {
  return (
    harnessAdapters.find(
      (adapter) => externalHarnessIds.includes(adapter.id) && adapter.matches(ref),
    )?.id ?? 'dsh'
  )
}
