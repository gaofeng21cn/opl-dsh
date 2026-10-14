import { HarnessConfigurationError } from '../../acp.ts'

/** The four mode ids the official ACP server accepts. */
export const KIMI_MODES = ['default', 'plan', 'auto', 'yolo'] as const
export type KimiMode = (typeof KIMI_MODES)[number]

export function isKimiMode(value: unknown): value is KimiMode {
  return typeof value === 'string' && (KIMI_MODES as readonly string[]).includes(value)
}

/**
 * What the suite can claim for a resolved permission, based on what was measured
 * against the official binary rather than on the mode's own description.
 *
 * `plan` was driven with a controlled provider through the real `Bash` tool: the tool
 * call was never executed and the target file was not created, so `read-only` here
 * means "the official tool did not run". It is not a claim that every possible write
 * path is blocked, and approval requests still route to the client's permission
 * callback.
 *
 * `yolo` was measured the other way: the official tool ran and wrote the file. That is
 * not a filesystem boundary, so `full-access` claims none.
 */
export type KimiIsolation = 'read-only' | 'none'

export interface KimiPermissionPlan {
  readonly mode: KimiMode
  readonly isolation: KimiIsolation
}

/**
 * Translate an authorized suite permission into one official ACP mode.
 *
 * `workspace` is refused rather than mapped: the official taxonomy has no mode that
 * bounds writes to the working directory, and `auto` is an approval policy, not a
 * filesystem boundary.
 */
export function kimiPermissionPlan(tier: string): KimiPermissionPlan {
  if (tier === 'read-only') return { mode: 'plan', isolation: 'read-only' }
  if (tier === 'full-access') return { mode: 'yolo', isolation: 'none' }
  if (tier === 'workspace')
    throw new HarnessConfigurationError(
      '官方 Kimi Code 未提供可验证的工作区写入隔离：其 mode 只有 plan 与审批策略，auto 档不是文件系统边界。' +
        '已停止，未启动 CLI，未把 workspace 扩大为完整访问。',
    )
  throw new HarnessConfigurationError(
    `Kimi Code 不支持的权限档位：${tier}。已停止，未启动 CLI，未降级为更宽松的权限。`,
  )
}

/** Permission tiers this adapter advertises, matching {@link kimiPermissionPlan}. */
export const KIMI_PERMISSIONS: readonly ('read-only' | 'full-access')[] = [
  'read-only',
  'full-access',
]
