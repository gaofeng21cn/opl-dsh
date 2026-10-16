/** Fixed error categories for official RPC agents; provider text never leaves this classifier. */
export function rpcProviderFailure(errorMessage: unknown): string {
  const text = typeof errorMessage === 'string' ? errorMessage : ''
  if (/OpenCode's free tier can only be used from within OpenCode/i.test(text))
    return 'HARNESS_PROVIDER_CLIENT_REQUIRED'
  if (/\b(?:401|403)\b|unauthor|forbidden|invalid[ _-]?api[ _-]?key/i.test(text))
    return 'HARNESS_PROVIDER_AUTH'
  if (/\b404\b|not found|unknown model|no such model/i.test(text)) return 'HARNESS_PROVIDER_MODEL'
  if (/\b429\b|rate[ _-]?limit|quota|daily limit/i.test(text)) return 'HARNESS_PROVIDER_RATE_LIMIT'
  if (/timeout|timed out/i.test(text)) return 'HARNESS_PROVIDER_TIMEOUT'
  if (/stream read failed|connection|ECONNRESET|ECONNREFUSED|network|fetch failed/i.test(text))
    return 'HARNESS_PROVIDER_NETWORK'
  return 'HARNESS_PROVIDER'
}

/** Latest assistant/retry verdict until the official agent has fully settled. */
export class RpcTurnOutcome {
  failure: string | undefined

  /** Consume official wire events without retaining provider error text. */
  accept(event: Record<string, unknown>): void {
    const message = event.message
    if (
      event.type === 'message_end' &&
      message !== null &&
      typeof message === 'object' &&
      'role' in message &&
      message.role === 'assistant'
    ) {
      const assistant = message as Record<string, unknown>
      if (assistant.stopReason === 'error')
        this.failure = rpcProviderFailure(assistant.errorMessage)
      else if (typeof assistant.stopReason === 'string') this.failure = undefined
    } else if (event.type === 'auto_retry_end') {
      if (event.success === false) this.failure = rpcProviderFailure(event.finalError)
      else if (event.success === true) this.failure = undefined
    }
  }

  /** Clear the verdict before a new prompt and after cancellation or settlement. */
  reset(): void {
    this.failure = undefined
  }
}
