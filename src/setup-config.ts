/** First-run account choice; authentication stays in its provider service. */
import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'
export type LoginChoice = 'undecided' | 'gateway' | 'official' | 'later'
export interface Config { loginChoice: Volatile<LoginChoice> }
export const Config = z.object({
  loginChoice: z.union(['undecided', 'gateway', 'official', 'later']).default('undecided').volatile(),
})
