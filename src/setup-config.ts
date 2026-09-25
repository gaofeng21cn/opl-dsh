/** First-run account choice; authentication stays in its provider service. */
import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'
export type LoginChoice = 'undecided' | 'gateway' | 'official' | 'later'
export interface Config { loginChoice: Volatile<LoginChoice>; setupCompleted: Volatile<boolean>; wakeTransport: Volatile<'unconnected' | 'codex-queue'>; wakeExecutable: Volatile<string>; wakeExecution: Volatile<'native' | 'wsl'>; wakeDistro: Volatile<string> }
export const Config = z.object({
  wakeTransport: z.union(['unconnected','codex-queue']).default('unconnected').volatile(),
  wakeExecutable: z.string().default('').volatile(),
  wakeExecution: z.union(['native','wsl']).default('native').volatile(),
  wakeDistro: z.string().default('').volatile(),
  setupCompleted: z.boolean().default(false).volatile(),
  loginChoice: z.union(['undecided', 'gateway', 'official', 'later']).default('undecided').volatile(),
})
