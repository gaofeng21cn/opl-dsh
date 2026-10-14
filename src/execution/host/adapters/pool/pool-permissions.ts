/**
 * Permission mapping for the official Poolside Agent CLI ACP server.
 *
 * The official CLI offers exactly three approval modes, measured over real ACP
 * on 1.0.16 (`session/set_config_option` with `configId: "mode"` advertises
 * `default`, `accept-edits` and `always-allow`; the same three ids are accepted
 * by `session/set_mode`, while `auto` and `plan` are rejected as session modes),
 * plus a separate `--sandbox` launch flag with `disabled` and `required`.
 *
 * Two consequences are load-bearing and deliberately not smoothed over:
 *
 * 1. **There is no verifiable restricted profile on this host.** `--sandbox
 *    required` is the official boundary, and it is a Docker sandbox: the official
 *    documentation states the local sandbox resolves its image through the local
 *    Docker engine, so tool commands run *inside* the container with the
 *    container's own shell. That is a different interpreter from the pinned Git
 *    Bash this host relies on, and this suite has not measured it. `read-only`
 *    and `workspace` are therefore refused instead of being widened to
 *    `always-access`-style approval-free execution.
 * 2. **`full-access` claims no isolation.** `always-allow` removes the human
 *    approval gate and `--sandbox disabled` runs on the host; neither confines
 *    the agent to the working directory. The returned `isolation` field states
 *    plainly what a caller actually got.
 *
 * Shell selection is a separate concern handled by `./pool-bash.ts`; no
 * permission value here ever influences which shell runs, and no shell choice
 * ever widens a permission.
 */
import { HarnessConfigurationError } from '../../acp.ts'

/** The approval mode ids the official ACP session accepts. */
export const POOL_MODES = ['default', 'accept-edits', 'always-allow'] as const
/** One official ACP mode id. */
export type PoolMode = (typeof POOL_MODES)[number]

/** The `--sandbox` values the official CLI accepts at launch. */
export const POOL_SANDBOX_MODES = ['disabled', 'required'] as const

/** Narrow an untrusted wire value to a mode this host may send. */
export function isPoolMode(value: unknown): value is PoolMode {
  return typeof value === 'string' && (POOL_MODES as readonly string[]).includes(value)
}

/**
 * What the suite can actually guarantee for a resolved permission.
 *
 * - `none`: no filesystem boundary of any kind. Used by `full-access`.
 * - `unverified`: a boundary whose enforcement this suite has not measured.
 *   Reserved for surfaces that offer one without measured evidence; the current
 *   mapping never returns it, which is the point.
 */
export type PoolIsolation = 'none' | 'unverified'

export interface PoolPermissionPlan {
  /** The exact `mode` value written to the session. */
  readonly mode: PoolMode
  /** The exact `--sandbox` value passed at launch. */
  readonly sandbox: (typeof POOL_SANDBOX_MODES)[number]
  /** What the suite can honestly claim about filesystem confinement. */
  readonly isolation: PoolIsolation
}

/**
 * Translate an authorized suite permission into one official ACP mode.
 *
 * @param tier - the authorized permission profile on the session record.
 * @returns the mode and sandbox flag to pin, plus the isolation claimed.
 * @throws HarnessConfigurationError for any tier this host cannot honour. The
 * failure happens before any process starts and never falls back to a more
 * permissive tier.
 */
export function poolPermissionPlan(tier: string): PoolPermissionPlan {
  if (tier === 'full-access')
    return { mode: 'always-allow', sandbox: 'disabled', isolation: 'none' }
  if (tier === 'read-only' || tier === 'workspace')
    throw new HarnessConfigurationError(
      '官方 pool 1.0.16 未提供可验证的受限执行档位：`--sandbox required` 是官方边界，但它是 Docker 沙箱，' +
        '工具命令在容器内以容器自身的 shell 执行，与本机固定的 Git Bash 不是同一个解释器，套件未做实测。' +
        '已停止，未启动 CLI，未把受限档位扩大为完整访问。请改用显式授权的 full-access，或改用具备已验证受限沙箱的 Harness。',
    )
  throw new HarnessConfigurationError(
    `pool 不支持的权限档位：${tier}。已停止，未启动 CLI，未降级为更宽松的权限。`,
  )
}

/** Permission tiers this adapter advertises, matching {@link poolPermissionPlan}. */
export const POOL_PERMISSIONS: readonly 'full-access'[] = ['full-access']
