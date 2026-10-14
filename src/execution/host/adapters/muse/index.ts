/**
 * Public entry for the official Muse Code adapter.
 *
 * `museCodeAdapter` is the adapter the registry consumes. The remaining exports are the
 * pieces the packager and the tests need: the pinned lane table, the permission plan,
 * the interpreter and MCP wiring, and the bridge's protocol pin.
 *
 * Deliberately absent: any source registration. `our-free-model` has exactly one owner,
 * and a local re-registration here would shadow that owner for every other Harness.
 */
export {
  createMuseCodeAdapter,
  museCodeAdapter,
  resolveMuseRoute,
  museStorage,
  MUSE_CREDENTIAL_ENV,
  MUSE_LAUNCH_ENV,
} from './muse.ts'
export type { MuseAdapterBuild, MuseStorage } from './muse.ts'
export {
  isMuseModel,
  museEffortValue,
  museLane,
  MUSE_COMMAND,
  MUSE_BOUND_BASE_URL,
  MUSE_EFFORTS,
  MUSE_HARNESS,
  MUSE_MODELS,
  MUSE_PROFILE_ID,
  MUSE_PROTOCOL,
  MUSE_PROVIDER,
  MUSE_PROVIDER_ID,
  MUSE_SCHEMA_FINGERPRINT,
  MUSE_SUPPORTS_SOURCE_ENDPOINT,
} from './muse-models.ts'
export type { MuseEffort, MuseLane, MuseModelId } from './muse-models.ts'
export { musePermissionPlan, museSandboxArgs, MUSE_APPROVAL_MODES } from './muse-permissions.ts'
export type { MuseApprovalMode, MusePermissionPlan } from './muse-permissions.ts'
export {
  assertBashToolUsable,
  museBashEnvironment,
  museMcpServer,
  museSettingsDocument,
  writeMuseSettings,
  MUSE_BASH_ENV,
  MUSE_MCP_SERVER,
  MUSE_MCP_TOOL,
} from './muse-bash.ts'
export type { MuseMcpServerEntry } from './muse-bash.ts'
