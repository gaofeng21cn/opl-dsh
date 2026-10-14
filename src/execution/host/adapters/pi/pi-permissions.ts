/**
 * Permission mapping for the official Pi Coding Agent CLI.
 *
 * Pi exposes **no permission vocabulary at all**. Its security documentation is explicit:
 * the agent runs with the permissions of the user who started it and "does not ask for
 * approval before every tool call"; the tools act on the project directory with the user's
 * own rights, and the only confinement offered is running under an OS sandbox or a
 * container. There is no preset table, no `ask` mode, and no read-only tier to map onto.
 *
 * That makes this mapping a refusal rather than a translation, and the refusal is the
 * load-bearing part:
 *
 * 1. **There is no read-only or workspace tier to offer.** Mapping the suite's
 *    `read-only` or `workspace` profile onto an agent that has no approval gate and no
 *    filesystem boundary would advertise confinement this product does not implement, so
 *    both tiers are refused outright rather than widened or quietly reinterpreted.
 * 2. **`full-access` claims no isolation.** It describes exactly what Pi does: every tool
 *    runs without a confirmation step, with the launching user's own permissions and no
 *    working-directory boundary. The `isolation` field says plainly which of the two a
 *    caller actually got, so no caller can mistake this for a sandbox.
 * 3. **Nothing here widens a tier to obtain a shell, and nothing chooses a shell.**
 *    Shell selection is a separate concern handled by `./pi-bash.ts`.
 *
 * The ACP projection does not answer any Pi dialog on the user's behalf: with no approval
 * gate, Pi raises none for ordinary tool calls, so a dialog reaching the bridge is
 * something the official product genuinely wants a human to decide and is relayed to the
 * host's real approval flow rather than auto-answered. See `./pi-bridge.ts`.
 */
import { HarnessConfigurationError } from '../../acp.ts'

/**
 * What the suite can honestly claim about filesystem confinement.
 *
 * - `none`: no filesystem boundary of any kind, and no approval gate in front of one.
 *   Used by `full-access`, which is the only tier this product can honour.
 */
export type PiIsolation = 'none' | 'unverified'

export interface PiPermissionPlan {
  /** The suite permission tier this launch runs under. */
  readonly tier: 'full-access'
  /** What the suite can honestly claim about filesystem confinement. */
  readonly isolation: PiIsolation
}

/**
 * Translate an authorized suite permission into what the official CLI can actually do.
 *
 * @param tier - the authorized permission profile on the session record.
 * @returns the tier this launch runs under, plus what this suite claims about isolation.
 * @throws HarnessConfigurationError for any tier this host cannot honour. The failure
 * happens before any process starts and never falls back to a more permissive tier.
 */
export function piPermissionPlan(tier: string): PiPermissionPlan {
  if (tier === 'full-access') return { tier: 'full-access', isolation: 'none' }
  if (tier === 'read-only' || tier === 'workspace')
    throw new HarnessConfigurationError(
      '官方 Pi 没有只读或工作区写入隔离：它的工具以启动用户的权限直接执行，不提供审批开关，' +
        '官方文档说明唯一的限制方式是外部操作系统沙箱或容器。已停止，未启动 pi，未把受限权限扩大为完整访问。' +
        '请改用显式授权的 full-access，或改用具备可验证沙箱的 Harness。',
    )
  throw new HarnessConfigurationError(
    `Pi 不支持的权限档位：${tier}。已停止，未启动 pi，未降级为更宽松的权限。`,
  )
}

/** Permission tiers this adapter advertises, matching {@link piPermissionPlan}. */
export const PI_PERMISSIONS: readonly ('read-only' | 'workspace' | 'full-access')[] = [
  'full-access',
]
