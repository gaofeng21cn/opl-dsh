/**
 * Permission posture for the official Muse Code CLI.
 *
 * Evidence from the installed binary (1.4.7-R6101.1, Windows):
 *
 *  - `muse serve --help` states that sandbox posture "is constructed here and
 *    applies to every session the host loads; neither is negotiable over the wire",
 *    and the same help separates approval mode as the value that *is* selected on
 *    the wire. So the only posture question a launch answers is the approval mode.
 *  - `initialize` reports `sandboxAvailability: "unavailable"` on this host. The
 *    CLI says so itself rather than pretending to isolate anything.
 *  - The Bash tool this adapter installs is an MCP server, and the official CLI
 *    runs MCP servers outside its own shell sandbox: the CLI's own diagnostics name
 *    it as a `tool:mcp__…` side effect rather than a shell execution. A restricted
 *    tier therefore could not bound the Bash tool, and claiming otherwise would be a
 *    boundary that does not exist.
 *
 * `full-access` is consequently the only advertised tier, and it is advertised
 * without claiming any workspace isolation. `read-only` and `workspace` are refused
 * at launch instead of being mapped onto a boundary that was never measured.
 */
import { HarnessConfigurationError } from '../../acp.ts'

/** MSP `ApprovalMode` values the CLI accepts on `session/start`. */
export const MUSE_APPROVAL_MODES = [
  'allowAll',
  'promptUnmatched',
  'onRequest',
  'denyUnmatched',
] as const
export type MuseApprovalMode = (typeof MUSE_APPROVAL_MODES)[number]

/** The one posture this adapter maps. */
export interface MusePermissionPlan {
  approvalMode: MuseApprovalMode
  /**
   * `--disable-sandbox`. Fixed for the host's lifetime by the official `serve`
   * contract, so it is decided once at launch and never re-negotiated per session.
   */
  disableSandbox: true
  /** Nothing isolates the MCP-hosted Bash tool, so full-access claims no boundary. */
  isolation: 'none'
}

/**
 * Refuse a permission tier this CLI cannot actually honour.
 * @param sandbox - the session's requested tier.
 * @returns the launch plan for the only supported tier.
 * @throws HarnessConfigurationError for every tier other than `full-access`, so the
 * session fails before any profile write, source resolution or CLI start.
 */
export function musePermissionPlan(sandbox: string): MusePermissionPlan {
  if (sandbox !== 'full-access')
    throw new HarnessConfigurationError(
      `官方 Muse Code 只提供完整访问：其 MCP 命令工具在原生 sandbox 之外运行，且 initialize 报告 sandboxAvailability=unavailable，未提供可验证的工作区或只读隔离；已停止，未启动 CLI，未回退其他权限档位。`,
    )
  return { approvalMode: 'allowAll', disableSandbox: true, isolation: 'none' }
}

/**
 * Startup flags the plan contributes. Kept next to the plan so a tier and the flags
 * that implement it cannot drift apart.
 * @param plan - the resolved posture.
 * @returns the `muse serve` flags for that posture.
 */
export function museSandboxArgs(plan: MusePermissionPlan): string[] {
  return plan.disableSandbox ? ['--disable-sandbox'] : []
}
