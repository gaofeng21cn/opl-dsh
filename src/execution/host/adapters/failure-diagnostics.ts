/** Credential-free facts projected from CLI error envelopes, never from response text. */
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const services = ['codex', 'zcode', 'session'] as const
const errorNames = [
  'NO_PROGRESS',
  'APIError',
  'ContextOverflowError',
  'StructuredOutputError',
  'provider_error',
  'api_error',
  'authentication_error',
  'rate_limit_error',
  'timeout_error',
  'network_error',
  'context_length_exceeded',
  'contextWindowExceeded',
  'usageLimitExceeded',
  'httpConnectionFailed',
  'responseStreamConnectionFailed',
  'responseStreamDisconnected',
  'responseTooManyFailedAttempts',
  'internalServerError',
  'unauthorized',
  'badRequest',
  'sandboxError',
  'other',
  'processExited',
  'protocolError',
] as const
const terminalStates = ['failed', 'interrupted', 'completed'] as const

/** Only these finite labels and validated protocol numbers may enter persisted errors. */
export interface HarnessFailureDetails {
  service?: (typeof services)[number]
  errorName?: (typeof errorNames)[number]
  terminalState?: (typeof terminalStates)[number]
  httpStatus?: number
  rpcCode?: number
}

/**
 * Read known structured error fields; strings containing JSON or HTTP text stay opaque.
 * @param input - a CLI error or the bridge's already projected error data.
 * @returns a new object containing only finite labels and validated numeric codes.
 */
export function safeFailureDetails(input: unknown): HarnessFailureDetails {
  const value = record(input)
  const data = record(value.data)
  const details = record(data.details)
  const candidates = [
    value,
    data,
    record(value.details),
    details,
    record(value.attribution),
    record(data.attribution),
  ]
  // ZCode wraps provider failures in a cause chain with structured context.
  let cause = value
  for (let depth = 0; depth < 5; depth++) {
    candidates.push(record(cause.context))
    cause = record(cause.cause)
    if (!Object.keys(cause).length) break
    candidates.push(cause)
  }
  const result: HarnessFailureDetails = {}
  for (const candidate of candidates) {
    const service = services.find((value) => value === candidate.service)
    if (service) result.service = service
    const terminalState = terminalStates.find((value) => value === candidate.terminalState)
    if (terminalState) result.terminalState = terminalState
    for (const name of [
      candidate.errorName,
      candidate.type,
      candidate.codexErrorInfo,
      candidate.providerCode,
      candidate.providerErrorCode,
    ]) {
      const recognized = errorNames.find((value) => value === name)
      if (recognized) result.errorName = recognized
    }
    const info = record(candidate.codexErrorInfo)
    for (const name of errorNames) {
      if (Object.hasOwn(info, name)) {
        result.errorName = name
        const status = record(info[name]).httpStatusCode
        if (
          typeof status === 'number' &&
          Number.isInteger(status) &&
          status >= 400 &&
          status <= 599
        )
          result.httpStatus = status
      }
    }
    for (const status of [candidate.httpStatus, candidate.httpStatusCode, candidate.statusCode])
      if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599)
        result.httpStatus = status
    const code = candidate.rpcCode ?? candidate.code
    if (
      typeof code === 'number' &&
      Number.isInteger(code) &&
      ([-32700, -32600, -32601, -32602, -32603].includes(code) ||
        (code >= -32099 && code <= -32000))
    )
      result.rpcCode = code
  }
  return result
}

/**
 * Format a bounded diagnostic suffix without reflecting CLI messages, URLs or bodies.
 * @param input - structured CLI error data.
 * @returns a suffix suitable for a persisted user-visible failure, or an empty string.
 */
export function failureDiagnosticSuffix(input: unknown): string {
  const details = safeFailureDetails(input)
  const labels: string[] = []
  if (details.service)
    labels.push({ codex: 'Codex', zcode: 'ZCode', session: '模型会话' }[details.service])
  if (details.httpStatus !== undefined) labels.push(`HTTP ${details.httpStatus}`)
  if (details.errorName) labels.push(`错误类别 ${details.errorName}`)
  if (details.terminalState) labels.push(`结束状态 ${details.terminalState}`)
  if (details.rpcCode !== undefined) labels.push(`RPC ${details.rpcCode}`)
  return labels.length ? `（${labels.join('；')}）` : ''
}

/** A failed official CLI operation carrying only the explicitly projected error facts. */
export class HarnessReportedError extends Error {
  readonly details: HarnessFailureDetails
  constructor(service: 'codex' | 'zcode', error: unknown, terminalState?: 'failed') {
    super('HARNESS_EXECUTION')
    this.details = {
      ...safeFailureDetails(error),
      service,
      ...(terminalState ? { terminalState } : {}),
    }
  }
}

/**
 * Construct the bridge's ACP error without reflecting arbitrary exception messages.
 * @param error - the failed bridge operation.
 * @returns fixed ACP code/message and, when present, credential-free CLI error facts.
 */
export function bridgeFailure(error: unknown) {
  return {
    code:
      error instanceof Error &&
      /^HARNESS_(AUTH|RATE_LIMIT|MODEL|EXECUTION|TIMEOUT|NETWORK)$/.test(error.message)
        ? error.message
        : 'HARNESS_UNKNOWN',
    message: '官方 Harness 调用未完成',
    ...(error instanceof HarnessReportedError ? { data: error.details } : {}),
  }
}
