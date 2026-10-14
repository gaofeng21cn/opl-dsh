/**
 * Permission mapping for the official StepCode CLI.
 *
 * StepCode exposes a three-preset product taxonomy selected by `STEP_PERMISSION_PRESET`
 * (`packages/coding-agent/src/step/permissions.ts`), and this adapter maps the suite's
 * authorized sandbox onto it:
 *
 * | StepCode preset   | approval mode | unattended | behavior                                                        |
 * | ----------------- | ------------- | ---------- | --------------------------------------------------------------- |
 * | `ask`             | `confirm`     | `deny`     | Ask before modifying files or running commands.                  |
 * | `approve-for-me`  | `auto`        | `allow`    | Routine actions run; unsafe-looking ones and key decisions ask.  |
 * | `full-access`     | `auto`        | `allow`    | Everything runs without confirmation, including dangerous commands.|
 *
 * Three consequences are load-bearing and deliberately not smoothed over:
 *
 * 1. **There is no read-only tier to map onto.** The official vocabulary retired it —
 *    `normalizeStepPermissionPresetId` folds `read-only`/`plan`/`strict` onto `ask` —
 *    and `ask` is an *approval policy*, not an operating-system filesystem boundary.
 *    Mapping the suite's `read-only` or `workspace` tier onto it would advertise
 *    confinement the product does not implement, so both tiers are refused outright
 *    instead of being widened or quietly reinterpreted.
 *
 * 2. **`full-access` claims no isolation.** The preset removes the human approval gate
 *    and additionally skips the dangerous-command policy (`skipCommandPolicy`). It does
 *    not confine the agent to the working directory. The returned `isolation` field
 *    states plainly which of the two a caller actually got.
 *
 * 3. **Full Access owes an interactive risk acknowledgment.** On `session_start` the
 *    official product asks the UI to confirm the risk and, without a grant, falls back
 *    to `Approve for Me` rather than executing dangerous commands. The bridge therefore
 *    answers that one dialog, and only when the combination's permission policy already
 *    says `full-access` — see `./step-bridge.ts`. Any other dialog still reaches the
 *    host's real approval flow.
 *
 * Shell selection is a separate concern handled by `./step-bash.ts`: no permission value
 * here influences which shell runs, and no shell choice ever widens a permission.
 */
import { HarnessConfigurationError } from '../../acp.ts'

/** The preset ids the official CLI accepts. */
export const STEP_PRESETS = ['ask', 'approve-for-me', 'full-access'] as const
/** One official StepCode preset id. */
export type StepPreset = (typeof STEP_PRESETS)[number]

/**
 * The environment variable the official CLI reads to select a permission preset.
 *
 * It is a documented product variable (`step --help`, `packages/coding-agent/src/
 * features/step.ts`), and it is set per launch from the authorized sandbox rather than
 * read from a persisted user profile.
 */
export const STEP_PERMISSION_PRESET_ENV = 'STEP_PERMISSION_PRESET'

/** Narrow an untrusted wire value to a preset this host may send. */
export function isStepPreset(value: unknown): value is StepPreset {
  return typeof value === 'string' && (STEP_PRESETS as readonly string[]).includes(value)
}

/**
 * What the suite can honestly claim about filesystem confinement.
 *
 * - `read-only`: the agent performs no tool execution. The current mapping never
 *   returns this, which is the point.
 * - `none`: no filesystem boundary of any kind. Used by `full-access`.
 */
export type StepIsolation = 'read-only' | 'none' | 'unverified'

export interface StepPermissionPlan {
  /** The exact `STEP_PERMISSION_PRESET` value written to the launch environment. */
  readonly preset: StepPreset
  /** What the suite can honestly claim about filesystem confinement. */
  readonly isolation: StepIsolation
  /**
   * Whether the bridge may answer the official Full Access risk acknowledgment on the
   * user's behalf. True only for the tier the user explicitly authorized in the
   * combination's permission policy.
   */
  readonly acknowledgeFullAccessRisk: boolean
}

/**
 * Translate an authorized suite permission into one official StepCode preset.
 *
 * @param tier - the authorized permission profile on the session record.
 * @returns the preset to launch with, plus what this suite claims about isolation.
 * @throws HarnessConfigurationError for any tier this host cannot honour. The failure
 * happens before any process starts and never falls back to a more permissive tier.
 */
export function stepPermissionPlan(tier: string): StepPermissionPlan {
  if (tier === 'full-access')
    return { preset: 'full-access', isolation: 'none', acknowledgeFullAccessRisk: true }
  if (tier === 'read-only' || tier === 'workspace')
    throw new HarnessConfigurationError(
      '官方 StepCode 没有只读或工作区写入隔离：其权限档位只有 ask（审批策略）、approve-for-me 与 full-access，' +
        '原本的只读档已在官方词汇中退役并被折叠为 ask，而 ask 是审批策略而不是文件系统边界。' +
        '已停止，未启动 step，未把受限权限扩大为完整访问。请改用显式授权的 full-access，或改用具备可验证沙箱的 Harness。',
    )
  throw new HarnessConfigurationError(
    `StepCode 不支持的权限档位：${tier}。已停止，未启动 step，未降级为更宽松的权限。`,
  )
}

/** Permission tiers this adapter advertises, matching {@link stepPermissionPlan}. */
export const STEP_PERMISSIONS: readonly ('read-only' | 'workspace' | 'full-access')[] = [
  'full-access',
]
