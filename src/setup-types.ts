import type { LoginChoice } from './setup-config.ts'
export interface SetupStatus {
  completed: boolean
  choice: LoginChoice
  gatewayReady: boolean
  officialProvider?: string
  officialPhase?: string
}
