/** Safe failure details shared by update discovery, preparation and handoff. */

const proxyCodes = new Set([
  'ERR_INVALID_PROXY_URL',
  'ERR_NO_SUPPORTED_PROXIES',
  'ERR_PROXY_AUTH_REQUIRED',
  'ERR_PROXY_CONNECTION_FAILED',
  'ERR_TUNNEL_CONNECTION_FAILED',
  'UND_ERR_PRX_CONN',
  'UND_ERR_PRX_TLS',
  'UND_ERR_SOCKS5_AUTH_FAILED',
  'UND_ERR_SOCKS5_AUTH_METHOD',
  'UND_ERR_SOCKS5_AUTH_REJECTED',
  'UND_ERR_SOCKS5_ADDR_TYPE',
  'UND_ERR_SOCKS5_REPLY_VERSION',
  'UND_ERR_SOCKS5_VERSION',
  'UND_ERR_TUNNEL_CONNECTION_FAILED',
])

const timeoutCodes = new Set([
  'ETIMEDOUT',
  'ERR_HTTP_HEADERS_TIMEOUT',
  'ERR_HTTP_REQUEST_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
])

const networkCodes = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'EAI_AGAIN',
  'EAI_FAIL',
  'EAI_NODATA',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTDOWN',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ERR_CERT_AUTHORITY_INVALID',
  'ERR_SSL_CERTIFICATE_VERIFY_FAILED',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_TLS_HANDSHAKE_TIMEOUT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UND_ERR_SOCKET',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
])

const busyCodes = new Set(['ERR_BUSY', 'ERR_UPDATE_IN_PROGRESS', 'SUITE-OPERATION-BUSY'])

const filesystemCodes = new Set([
  'EACCES',
  'EBADF',
  'EEXIST',
  'EIO',
  'EISDIR',
  'EMFILE',
  'ENFILE',
  'ENOENT',
  'ENOSPC',
  'ENOTDIR',
  'EPERM',
  'EROFS',
])

const proxyNames = new Set([
  'ProxyError',
  'ProxyConnectionError',
  'SecureProxyConnectionError',
  'Socks5ProxyError',
  'TunnelError',
])
const timeoutNames = new Set([
  'TimeoutError',
  'ConnectTimeoutError',
  'HeadersTimeoutError',
  'BodyTimeoutError',
])
const networkNames = new Set([
  'NetworkError',
  'SocketError',
  'CertificateError',
  'CertError',
  'TLSError',
])

const acceptedCodes = new Set([
  ...proxyCodes,
  ...timeoutCodes,
  ...networkCodes,
  ...busyCodes,
  ...filesystemCodes,
])

const stages = new Set([
  'acquire',
  'installation',
  'discovery',
  'download',
  'verify',
  'stage',
  'confirm',
  'cancel',
  'apply',
  'save',
])

const reasons = new Set([
  'network',
  'proxy',
  'timeout',
  'http',
  'integrity',
  'busy',
  'installation',
  'release-changed',
  'filesystem',
  'unknown',
])

function safeCode(value) {
  if (typeof value !== 'string') return undefined
  const code = value.toUpperCase()
  return acceptedCodes.has(code) ? code : undefined
}

function safeDetails(value, fallbackStage) {
  if (!value || typeof value !== 'object') return undefined
  const row = value
  if (!stages.has(row.stage) || !reasons.has(row.reason)) return undefined
  const details = { stage: row.stage, reason: row.reason }
  if (Number.isInteger(row.httpStatus) && row.httpStatus >= 100 && row.httpStatus <= 599)
    details.httpStatus = row.httpStatus
  const systemCode = safeCode(row.systemCode)
  if (systemCode !== undefined) details.systemCode = systemCode
  return { ...details, stage: stages.has(row.stage) ? row.stage : fallbackStage }
}

function errorChain(error) {
  const chain = []
  const seen = new Set()
  let current = error
  while (current && typeof current === 'object' && chain.length < 8 && !seen.has(current)) {
    chain.push(current)
    seen.add(current)
    current = current.cause
  }
  return chain
}

function errorCode(row) {
  const value = row && typeof row === 'object' ? row.code : undefined
  return safeCode(value)
}

function errorName(row) {
  const value = row && typeof row === 'object' ? row.name : undefined
  return typeof value === 'string' ? value : ''
}

function errorIdentity(row) {
  return errorCode(row) ?? safeCode(errorName(row))
}

function reasonFor(chain) {
  const codes = chain.map(errorIdentity).filter((code) => code !== undefined)
  const names = chain.map(errorName)
  if (codes.some((code) => proxyCodes.has(code)) || names.some((name) => proxyNames.has(name)))
    return 'proxy'
  if (codes.some((code) => timeoutCodes.has(code)) || names.some((name) => timeoutNames.has(name)))
    return 'timeout'
  if (codes.some((code) => busyCodes.has(code))) return 'busy'
  if (codes.some((code) => networkCodes.has(code)) || names.some((name) => networkNames.has(name)))
    return 'network'
  if (codes.some((code) => filesystemCodes.has(code))) return 'filesystem'
  return 'unknown'
}

/**
 * Return bounded failure data without copying arbitrary error text or fields.
 * @param {unknown} error Failure value from an update operation.
 * @param {import('./update-errors.d.mts').UpdateFailureStage} stage Fallback operation stage.
 * @returns {import('./update-errors.d.mts').UpdateFailureDetails} Safe failure details.
 */
export function describeUpdateFailure(error, stage) {
  if (!stages.has(stage)) throw new TypeError(`invalid update failure stage: ${String(stage)}`)
  for (const row of errorChain(error)) {
    const details = safeDetails(row.updateFailure, stage)
    if (details !== undefined) return details
  }
  const chain = errorChain(error)
  const codes = chain.map(errorIdentity).filter((code) => code !== undefined)
  const details = { stage, reason: reasonFor(chain) }
  const systemCode = codes[0]
  if (systemCode !== undefined) details.systemCode = systemCode
  return details
}

/**
 * Preserve the cause for diagnostics while exposing only validated details.
 * @param {unknown} error Failure value from an update operation.
 * @param {import('./update-errors.d.mts').UpdateFailureStage} stage Operation stage.
 * @param {import('./update-errors.d.mts').UpdateFailureReason} [reason] Explicit reason.
 * @returns {Error & {updateFailure: import('./update-errors.d.mts').UpdateFailureDetails}} Typed failure.
 */
export function updateFailureError(error, stage, reason) {
  if (!stages.has(stage)) throw new TypeError(`invalid update failure stage: ${String(stage)}`)
  if (reason !== undefined && !reasons.has(reason))
    throw new TypeError(`invalid update failure reason: ${String(reason)}`)
  const described = describeUpdateFailure(error, stage)
  const details = reason === undefined ? described : { ...described, reason }
  const row = error && typeof error === 'object' ? error : undefined
  const message = row && typeof row.message === 'string' ? row.message : String(error)
  const wrapped = new Error(message, { cause: error })
  if (row && typeof row.name === 'string') wrapped.name = row.name
  Object.defineProperty(wrapped, 'updateFailure', {
    value: details,
    enumerable: true,
  })
  return wrapped
}
