/** Type declarations for the Muse Responses relay and namespace translation. */
interface NamedTool extends Record<string, unknown> {
  name: string
}

/** Translate declared tools and retain the caller's remaining request fields. */
export function museToolWire<B extends Record<string, unknown>>(
  body: B,
): {
  body: Omit<B, 'tools'> & { tools: NamedTool[]; reasoning_effort?: string }
  /** Restore names while retaining the supplied event fields. */
  restore<T extends Record<string, unknown>>(value: T): T
  /** Restore a stream event and emit ordered completion events. */
  events(
    value: Record<string, unknown>,
  ): Array<Record<string, unknown> & { sequence_number: number }>
}

/** Bind a loopback relay whose close aborts and drains its owned requests. */
export function startMuseEndpoint(options: { baseURL: string; apiKey: string }): Promise<{
  baseURL: string
  apiKey: string
  close(): Promise<void>
}>
