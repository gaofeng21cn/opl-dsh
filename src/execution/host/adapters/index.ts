import type { ModelRef } from '../../contracts/catalog.ts'
import { dshAdapter } from './dsh.ts'
import { grokAdapter } from './grok.ts'
import { codexAdapter } from './codex.ts'
import { claudeAdapter } from './claude.ts'
import { minimaxCodeAdapter, MINIMAX_CODE_HARNESS } from './minimax.ts'
import { withMinimaxPermissions } from './minimax-permissions.ts'
import { zcodeAdapter } from './zcode.ts'
import { withZcodePermissions } from './zcode-permissions.ts'
import type { HarnessAdapter } from './types.ts'
/**
 * Harnesses that own their own model catalog and authentication. An automatic
 * combination must bind one of these instead of the DSH loop, because DSH cannot
 * route a model that belongs to an external official CLI account.
 */
const externalHarnessIds: readonly string[] = ['codex', 'claude', MINIMAX_CODE_HARNESS, 'zcode']
export const harnessAdapters: readonly HarnessAdapter[] = [
  codexAdapter,
  claudeAdapter,
  withMinimaxPermissions(minimaxCodeAdapter),
  withZcodePermissions(zcodeAdapter),
  grokAdapter,
  dshAdapter,
]
export function adapterFor(id: string, ref: ModelRef): HarnessAdapter | undefined {
  return harnessAdapters.find((adapter) => adapter.id === id && adapter.matches(ref))
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
