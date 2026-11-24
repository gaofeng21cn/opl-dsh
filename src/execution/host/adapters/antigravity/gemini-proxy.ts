/** Selected-model loopback proxy for Antigravity native Gemini requests. */
import {
  Agent as HttpAgent,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import type { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  createSseEventTransform,
  readBoundedBody,
  startLoopbackServer,
  timingSafeTokenMatch,
} from '../loopback-relay.ts'

/** One resolved native Gemini route produced by the suite model source. */
export interface AntigravityNativeRoute {
  readonly baseURL: string
  readonly model: string
  readonly apiKey: string
  readonly protocol: 'gemini-native'
  readonly contextWindow?: number
}

/** Terminal upstream failure categories; provider text and keys never leave the proxy. */
export interface GeminiProxyFailure {
  readonly kind: 'http' | 'network' | 'stream' | 'policy'
  readonly httpStatus?: number
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

class GeminiStreamError extends Error {
  constructor(readonly failure: GeminiProxyFailure = { kind: 'stream' }) {
    super('Native Gemini response stream did not complete')
  }
}

/**
 * Parse SSE line endings and emit one compact JSON data event at a time.
 * @param onPayload - Observes decoded payloads without modifying candidate or usage fields.
 * @returns A streaming transform that rejects malformed or incomplete native responses.
 */
export function normalizeGeminiSse(onPayload?: (value: unknown) => void): Transform {
  const candidates = new Set<number>()
  const finished = new Set<number>()
  const frameLimit = 16 * 1024 * 1024

  return createSseEventTransform({
    maxBufferSize: frameLimit,
    onIncompleteTrailingEvent: () => new GeminiStreamError(),
    onError(error) {
      if (error.type === 'max-buffer-size-exceeded') throw new GeminiStreamError()
    },
    onEvent(event, push) {
      const raw = event.data
      if (raw === '[DONE]') {
        if (!candidates.size || [...candidates].some((index) => !finished.has(index)))
          throw new GeminiStreamError()
        return
      }
      let payload: unknown
      try {
        payload = JSON.parse(raw)
      } catch {
        throw new GeminiStreamError()
      }
      const value = object(payload)
      if (!Object.keys(value).length) throw new GeminiStreamError()
      if (event.event === 'error' || Object.hasOwn(value, 'error')) {
        const code = object(value.error).code
        throw new GeminiStreamError({
          kind: 'stream',
          ...(typeof code === 'number' && Number.isInteger(code) && code >= 400 && code <= 599
            ? { httpStatus: code }
            : {}),
        })
      }
      if (typeof object(value.promptFeedback).blockReason === 'string')
        throw new GeminiStreamError()
      if (Array.isArray(value.candidates)) {
        for (const entry of value.candidates) {
          const candidate = object(entry)
          const index = candidate.index === undefined ? 0 : candidate.index
          if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0)
            throw new GeminiStreamError()
          candidates.add(index)
          if (typeof candidate.finishReason === 'string' && candidate.finishReason.length)
            finished.add(index)
        }
      }
      onPayload?.(payload)
      push('data: ' + JSON.stringify(payload) + '\n\n')
    },
    onFlush() {
      if (!candidates.size || [...candidates].some((index) => !finished.has(index)))
        throw new GeminiStreamError()
    },
  })
}

interface ForwardedRequest {
  readonly scope: number
  readonly response: ServerResponse
  request?: ClientRequest
  upstream?: IncomingMessage
}

/** A loopback relay whose errors and sockets belong to a single active ACP prompt. */
export interface AntigravityGeminiProxy {
  readonly baseURL: string
  readonly key: string
  /** Begin before forwarding session/prompt; only one prompt may own native requests. */
  beginPrompt(): number
  /** Stop attributing requests and abort any uncompleted sockets from this prompt. */
  finishPrompt(scope: number): void
  /** Close all sockets and listeners; repeated disposal shares the same completion. */
  close(): Promise<void>
}

/**
 * Forward native Gemini requests using the selected Harness proxy environment.
 * @param options - One exact source route, hook readiness check, and prompt-scoped observers.
 * @returns An authenticated loopback endpoint and an awaited disposal operation.
 */
export async function startAntigravityGeminiProxy(options: {
  route: AntigravityNativeRoute
  env?: NodeJS.ProcessEnv
  beforeForward?: () => Promise<void>
  onFailure?: (scope: number, failure: GeminiProxyFailure) => void
  onUsageMetadata?: (scope: number, value: unknown) => void
}): Promise<AntigravityGeminiProxy> {
  const upstream = new URL(options.route.baseURL)
  if (
    !['https:', 'http:'].includes(upstream.protocol) ||
    (upstream.protocol === 'http:' &&
      !['127.0.0.1', 'localhost', '[::1]'].includes(upstream.hostname)) ||
    upstream.username ||
    upstream.password ||
    upstream.search ||
    upstream.hash ||
    upstream.pathname !== '/' ||
    options.route.protocol !== 'gemini-native' ||
    !options.route.apiKey ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(options.route.model)
  )
    throw Error('Antigravity requires a resolved native Gemini origin and exact model')
  const env = options.env ?? process.env
  const httpAgent = new HttpAgent({ proxyEnv: env, keepAlive: true })
  const httpsAgent = new HttpsAgent({ proxyEnv: env, keepAlive: true })
  const nativePath = `/v1beta/models/${options.route.model}:streamGenerateContent`
  const inflight = new Set<ForwardedRequest>()
  const failures = new Set<number>()
  let nextScope = 0
  let active: number | undefined
  let closed = false

  function report(scope: number, failure: GeminiProxyFailure): void {
    if (closed || active !== scope || failures.has(scope)) return
    failures.add(scope)
    options.onFailure?.(scope, failure)
  }

  function abortScope(scope: number): void {
    for (const item of inflight) {
      if (item.scope !== scope) continue
      item.upstream?.destroy()
      item.request?.destroy()
      item.response.destroy()
      inflight.delete(item)
    }
  }

  let relay
  try {
    relay = await startLoopbackServer(
      (key) => (req, res) => {
        const scope = active
        let url: URL
        try {
          url = new URL(req.url ?? '', 'http://127.0.0.1')
        } catch {
          req.resume()
          res.writeHead(400).end()
          return
        }
        const queryKey = url.searchParams.get('key') ?? undefined
        const headerKey =
          typeof req.headers['x-goog-api-key'] === 'string'
            ? req.headers['x-goog-api-key']
            : undefined
        const bearer = req.headers.authorization?.startsWith('Bearer ')
          ? req.headers.authorization.slice('Bearer '.length)
          : undefined
        const authenticated =
          timingSafeTokenMatch(headerKey, key) ||
          timingSafeTokenMatch(bearer, key) ||
          timingSafeTokenMatch(queryKey, key)
        const queryValid =
          url.searchParams.get('alt') === 'sse' &&
          [...url.searchParams.keys()].every((name) => ['alt', 'key'].includes(name)) &&
          url.searchParams.getAll('alt').length === 1 &&
          url.searchParams.getAll('key').length <= 1
        if (
          closed ||
          req.method !== 'POST' ||
          url.origin !== 'http://127.0.0.1' ||
          url.pathname !== nativePath ||
          !queryValid ||
          !authenticated ||
          scope === undefined ||
          failures.has(scope)
        ) {
          // CLI auxiliary models are intentionally refused without billing another model or
          // attributing their failure to the selected model's current request.
          req.resume()
          res.writeHead(403, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              error: { code: 403, status: 'PERMISSION_DENIED', message: 'Route not selected' },
            }),
          )
          return
        }
        const item: ForwardedRequest = { scope, response: res }
        inflight.add(item)
        res.once('close', () => {
          item.request?.destroy()
          inflight.delete(item)
        })
        void (async () => {
          const read = await readBoundedBody(req, 64 * 1024 * 1024)
          if (!read.ok) {
            inflight.delete(item)
            if (read.reason === 'too-large') {
              report(scope, { kind: 'policy' })
              res.writeHead(413).end()
            } else {
              res.destroy()
            }
            return
          }
          const body = read.body
          let parsed: unknown
          try {
            parsed = JSON.parse(body.toString('utf8'))
          } catch {
            report(scope, { kind: 'policy' })
            res.writeHead(400).end()
            return
          }
          if (
            !parsed ||
            typeof parsed !== 'object' ||
            Array.isArray(parsed) ||
            (object(parsed).model !== undefined && object(parsed).model !== options.route.model)
          ) {
            report(scope, { kind: 'policy' })
            res.writeHead(400).end()
            return
          }
          try {
            await options.beforeForward?.()
          } catch {
            report(scope, { kind: 'policy' })
            if (!res.destroyed) res.writeHead(503).end()
            return
          }
          if (closed || active !== scope || failures.has(scope) || res.destroyed) {
            res.destroy()
            return
          }
          const request = upstream.protocol === 'https:' ? httpsRequest : httpRequest
          const forward = request(
            new URL(nativePath + '?alt=sse', upstream),
            {
              method: 'POST',
              agent: upstream.protocol === 'https:' ? httpsAgent : httpAgent,
              headers: {
                'x-goog-api-key': options.route.apiKey,
                'content-type': 'application/json',
                'content-length': body.length,
                'accept-encoding': 'identity',
              },
            },
            (response) => {
              item.upstream = response
              const status = response.statusCode ?? 502
              if (status < 200 || status >= 300) {
                report(scope, { kind: 'http', httpStatus: status })
                response.destroy()
                if (!res.destroyed)
                  res.writeHead(status, { 'content-type': 'application/json' }).end(
                    JSON.stringify({
                      error: { code: status, message: 'Native Gemini request failed' },
                    }),
                  )
                return
              }
              if (
                !String(response.headers['content-type'])
                  .toLowerCase()
                  .includes('text/event-stream')
              ) {
                report(scope, { kind: 'stream' })
                response.destroy()
                if (!res.destroyed) res.writeHead(502).end()
                return
              }
              res.writeHead(status, {
                'content-type': 'text/event-stream; charset=utf-8',
                'cache-control': 'no-store',
              })
              const normalize = normalizeGeminiSse((payload) => {
                if (closed || active !== scope || failures.has(scope)) return
                const usage = object(payload).usageMetadata
                if (usage !== undefined) options.onUsageMetadata?.(scope, usage)
              })
              void pipeline(response, normalize, res).catch((error: unknown) => {
                report(
                  scope,
                  error instanceof GeminiStreamError ? error.failure : { kind: 'network' },
                )
                res.destroy()
              })
            },
          )
          item.request = forward
          forward.once('error', () => {
            report(scope, { kind: 'network' })
            if (!res.headersSent && !res.destroyed) res.writeHead(502).end()
            else res.destroy()
          })
          forward.end(body)
        })().catch(() => {
          report(scope, { kind: 'network' })
          res.destroy()
        })
      },
      { unavailableMessage: 'Antigravity loopback address unavailable' },
    )
  } catch (error) {
    httpAgent.destroy()
    httpsAgent.destroy()
    throw error
  }

  return {
    baseURL: relay.baseURL(),
    key: relay.token,
    beginPrompt() {
      if (closed || active !== undefined) throw Error('Antigravity native prompt is already active')
      active = ++nextScope
      return active
    },
    finishPrompt(scope) {
      if (active === scope) active = undefined
      abortScope(scope)
      failures.delete(scope)
    },
    close: () =>
      relay.close(() => {
        closed = true
        active = undefined
        for (const item of inflight) {
          item.upstream?.destroy()
          item.request?.destroy()
          item.response.destroy()
        }
        inflight.clear()
        failures.clear()
        httpAgent.destroy()
        httpsAgent.destroy()
      }),
  }
}
