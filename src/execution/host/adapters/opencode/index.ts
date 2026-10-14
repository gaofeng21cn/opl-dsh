/**
 * Public entry for the official OpenCode (`opencode`) adaptation.
 *
 * The suite's shared adapter index is owned elsewhere; this module exports the adapter,
 * the pairing source helper, and a small factory so wiring it in is a single, reviewable
 * change that does not fork any shared registry, catalog, or settings surface.
 * Credentials stay with the model source, the program stays with the execution engine, and
 * the binding stays with the execution combination — no new provider page, navigation
 * entry, or duplicate config is introduced here.
 */
import type { HarnessAdapter } from '../types.ts'
import { openCodeAdapter } from './opencode.ts'

export {
  openCodeAdapter,
  openCodeLaunch,
  openCodePath,
  openCodeProfileRoots,
  OPENCODE_HARNESS,
  OPENCODE_OFM_MODELS,
  OPENCODE_OFM_PROVIDER,
  OPENCODE_ROUTE_PROVIDER_ID,
  OPENCODE_SUPPORTED_PROTOCOLS,
  buildOpenCodeRouteConfig,
  openCodeModelValue,
} from './opencode.ts'
export {
  assertOpenCodeModelOffered,
  assertOpenCodeModelPinned,
  isOpenCodeModel,
  openCodeConfigOption,
  openCodeModels,
  OPENCODE_MODEL_OPTION,
  OPENCODE_SET_CONFIG_OPTION,
  type OpenCodeSelectOption,
} from './opencode-models.ts'
export {
  openCodeShellBinding,
  openCodeShellSelectionAccepts,
  sameShellFile,
  verifyOpenCodeGitBash,
  withOpenCodeShell,
  OPENCODE_GIT_BASH_VARIABLE,
  OPENCODE_SHELL_CONFIG_KEY,
  OPENCODE_SHELL_FACTS,
  OPENCODE_SHELL_VARIABLE,
  type OpenCodeShellBinding,
  type OpenCodeShellOptions,
} from './opencode-shell.ts'
export {
  createOpenCodeSource,
  isExcludedOpenCodeModel,
  OPENCODE_EXCLUDED_MODELS,
  type OpenCodeSourceAnswer,
  type OpenCodeSourceOwner,
} from './source.ts'

/**
 * Append the adapter to an existing registry without mutating the caller's array.
 *
 * Idempotent by adapter id, so re-running registration during plugin reload cannot
 * register the same harness twice.
 *
 * @param adapters - the suite's current adapter registry.
 * @returns a new registry including this adapter exactly once.
 */
export function withOpenCodeAdapter(
  adapters: readonly HarnessAdapter[] = [],
): readonly HarnessAdapter[] {
  if (adapters.some((adapter) => adapter.id === openCodeAdapter.id)) return adapters
  return [...adapters, openCodeAdapter]
}
