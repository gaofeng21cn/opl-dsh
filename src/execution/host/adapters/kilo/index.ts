/**
 * Public entry for the official Kilo (`kilo`) adaptation.
 *
 * The suite's shared adapter index is owned elsewhere; this module exports the adapter, the
 * pairing source helper, and a small factory so wiring it in is a single, reviewable change
 * that does not fork any shared registry, catalog, or settings surface.
 *
 * Credentials stay with the model source, the program stays with the execution engine, and
 * the binding stays with the execution combination — no new provider page, navigation entry,
 * or duplicate config is introduced here.
 */
import type { HarnessAdapter } from '../types.ts'
import { kiloAdapter } from './kilo.ts'

export {
  kiloAdapter,
  kiloLaunch,
  kiloPath,
  kiloProfileRoots,
  KILO_HARNESS,
  KILO_OFM_MODELS,
  KILO_OFM_PROVIDER,
  KILO_ROUTE_PROVIDER_ID,
  KILO_SUPPORTED_PROTOCOLS,
  buildKiloRouteConfig,
  kiloModelValue,
} from './kilo.ts'
export {
  assertKiloModelOffered,
  assertKiloModelPinned,
  assertNoKiloEffort,
  isExcludedKiloModel,
  KILO_EFFORT_FACTS,
  KILO_EFFORT_OPTION,
  KILO_EXCLUDED_MODELS,
  KILO_MODEL_OPTION,
  KILO_PROTOCOL,
  KILO_SET_CONFIG_OPTION,
  isKiloModel,
  kiloConfigOption,
  kiloModels,
  type KiloSelectOption,
} from './kilo-models.ts'
export {
  kiloShellBinding,
  kiloShellSelectionAccepts,
  sameShellFile,
  verifyKiloGitBash,
  withKiloShell,
  KILO_GIT_BASH_VARIABLE,
  KILO_SHELL_CONFIG_KEY,
  KILO_SHELL_FACTS,
  KILO_SHELL_VARIABLE,
  type KiloShellBinding,
  type KiloShellOptions,
} from './kilo-shell.ts'
export { createKiloSource, type KiloSourceAnswer, type KiloSourceOwner } from './source.ts'

/**
 * Append the adapter to an existing registry without mutating the caller's array.
 *
 * Idempotent by adapter id, so re-running registration during plugin reload cannot register
 * the same harness twice.
 *
 * @param adapters - the suite's current adapter registry.
 * @returns a new registry including this adapter exactly once.
 */
export function withKiloAdapter(
  adapters: readonly HarnessAdapter[] = [],
): readonly HarnessAdapter[] {
  if (adapters.some((adapter) => adapter.id === kiloAdapter.id)) return adapters
  return [...adapters, kiloAdapter]
}
