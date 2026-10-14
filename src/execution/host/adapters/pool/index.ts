/**
 * Owned exports for the official Poolside Agent CLI (`pool acp`) adapter.
 *
 * The suite's shared adapter index and registry stay untouched: the main review
 * wires {@link poolAdapter} into the catalog and the harness registry, which also
 * supplies the `pool` detection entry (binary name, `--version`, install note).
 */
export {
  POOL_HARNESS,
  POOL_LAGUNA_S,
  POOL_LAGUNA_XS,
  POOL_MODE_OPTION,
  POOL_MODELS,
  POOL_MODEL_OPTION,
  POOL_PROTOCOL,
  POOL_PROVIDER,
  POOL_THOUGHT_OPTION,
  isPoolModel,
  poolModels,
  poolThoughtValue,
} from './pool-models.ts'

export {
  POOL_MODES,
  POOL_PERMISSIONS,
  POOL_SANDBOX_MODES,
  isPoolMode,
  poolPermissionPlan,
} from './pool-permissions.ts'

export {
  POOL_AUDIT_MAX_BYTES,
  POOL_GIT_BASH_ARGS,
  POOL_HOOK_COMMAND_NAME,
  POOL_HOOK_FILE,
  POOL_NODE_ENV,
  POOL_SETTINGS_FILE,
  POOL_SHELL_ARGS_VARIABLE,
  POOL_SHELL_AUDIT_VARIABLE,
  POOL_SHELL_HOOK_NAME,
  POOL_SHELL_VARIABLE,
  poolHookCommand,
  poolHookCommandPosix,
  poolHookCommandWindows,
  poolSettings,
  poolSettingsLayouts,
  poolShellHookSource,
  poolShellPath,
} from './pool-shell-hook.ts'

export {
  POOL_POSIX_SHELL,
  poolHookDirectory,
  poolSettingsPath,
  poolShellEnvironment,
  poolShellVariables,
  resolvePoolShell,
  verifyPoolShell,
  verifyPoolShellHook,
} from './pool-bash.ts'

export {
  POOL_VERIFIED_VERSION,
  assertPoolAcpVersion,
  capturePoolSourceGuard,
  poolAcpLaunch,
  poolAdapter,
  poolConfigOption,
  poolPinnedModel,
  poolSessionModel,
} from './pool.ts'
