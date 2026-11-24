/** The personal Google sign-in and models advertised by the configured Antigravity CLI. */
export interface AntigravityAccountStatus {
  status: 'ready' | 'signed-out' | 'signing-in' | 'unavailable' | 'unknown'
  models: string[]
  labels?: Record<string, string>
}
