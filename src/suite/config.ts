import type { GatewayChannelProfile } from '../gateway/host/channel-defaults.ts'
import { Config as GatewayConfig } from '../gateway/host/config.ts'
import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'
import type { LoginChoice } from '../setup/contracts.ts'
import { executionLimitsSchema, type ExecutionLimits } from '../execution/contracts/limits.ts'
export type { LoginChoice } from '../setup/contracts.ts'
export interface Config {
  /** Exact Loader disabled values saved by the explicit Windows Git Bash selection. */
  nativeShellReceipt: Volatile<string>
  /** Check stable OPL releases automatically according to the selected update policy. */
  updateAutomatic: Volatile<boolean>
  updatePolicy: Volatile<import('../updates/contracts.ts').OplUpdatePolicy>
  /** Distinguish a current explicit policy from the legacy reminder default. */
  updatePolicyChosen: Volatile<boolean>
  /** Whether the activity pill counts retained conversation steps or every historical step. */
  conversationStats: Volatile<'current' | 'history'>
  /** Legacy master switch retained only to migrate older profiles. */
  enhancedConversationStats: Volatile<boolean>
  /** Keep the desktop window and taskbar title fixed instead of following the active Session. */
  fixedWindowTitle: Volatile<boolean>
  gatewayGroups: Volatile<Record<string, boolean>>
  gatewayCatalogHashes: Volatile<Record<string, string>>
  gatewayChannels: Volatile<Record<string, GatewayChannelProfile>>
  gateway: Volatile<import('../gateway/host/config.ts').Config>
  loginChoice: Volatile<LoginChoice>
  setupCompleted: Volatile<boolean>
  executionEnabled: Volatile<boolean>
  collaborationEnabled: Volatile<boolean>
  executionLimits: Volatile<ExecutionLimits>
  /** Persist explicit native permission choices as the official future-session default. */
  rememberPermissionPreset: Volatile<boolean>
  /** Project the dedicated official mcode integration; saved routes survive opt-out. */
  minimaxCodeEnabled: Volatile<boolean>
  cooperation: Volatile<{ autoReview: boolean; maxRevisions: number; externalCodex: boolean }>
  roleExecutions: Volatile<Record<string, string>>
  wakeTransport: Volatile<'unconnected' | 'codex-queue'>
  wakeExecutable: Volatile<string>
  wakeExecution: Volatile<'native' | 'wsl'>
  wakeDistro: Volatile<string>
}
export function minimaxCodeConfigChanged(paths: readonly (readonly string[])[]): boolean {
  return paths.some((path) => path.length === 1 && path[0] === 'minimaxCodeEnabled')
}
export const Config = z.object({
  nativeShellReceipt: z.string().default('').volatile(),
  updateAutomatic: z.boolean().default(true).volatile(),
  updatePolicy: z
    .object({
      mode: z.union(['notify', 'on-launch', 'idle']).default('on-launch'),
      idleMinutes: z.number().step(1).min(1).max(120).default(5),
      countdownSeconds: z.number().step(1).min(15).max(300).default(30),
    })
    .default({})
    .volatile(),
  updatePolicyChosen: z.boolean().default(false).volatile(),
  conversationStats: z.union(['current', 'history']).default('history').volatile(),
  enhancedConversationStats: z.boolean().default(false).volatile(),
  fixedWindowTitle: z.boolean().default(true).volatile(),
  gatewayGroups: z.dict(z.boolean()).default({}).volatile(),
  gatewayCatalogHashes: z.dict(z.string()).default({}).volatile(),
  gatewayChannels: z.dict(z.any()).default({}).volatile(),
  gateway: GatewayConfig.default({}).volatile(),
  setupCompleted: z.boolean().default(false).volatile(),
  loginChoice: z
    .union(['undecided', 'gateway', 'official', 'later'])
    .default('undecided')
    .volatile(),
  executionEnabled: z.boolean().default(true).volatile(),
  collaborationEnabled: z.boolean().default(true).volatile(),
  executionLimits: executionLimitsSchema.volatile(),
  rememberPermissionPreset: z.boolean().default(false).volatile(),
  minimaxCodeEnabled: z.boolean().default(true).volatile(),
  cooperation: z
    .object({
      autoReview: z.boolean().default(true),
      maxRevisions: z.number().step(1).min(0).max(5).default(2),
      externalCodex: z.boolean().default(true),
    })
    .default({})
    .volatile(),
  roleExecutions: z.dict(z.string().min(1)).default({}).volatile(),
  wakeTransport: z.union(['unconnected', 'codex-queue']).default('unconnected').volatile(),
  wakeExecutable: z.string().default('').volatile(),
  wakeExecution: z.union(['native', 'wsl']).default('native').volatile(),
  wakeDistro: z.string().default('').volatile(),
})
