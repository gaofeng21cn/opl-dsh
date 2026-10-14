/** Authenticated OFM management reads stay inside the Host and never enter model output. */
import { symbols, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'

const paths = [
  '/summary',
  '/clients',
  '/forward/key',
  '/chan-gateway',
  '/chan-gateway/key',
] as const
export type OfmOwnerReadPath = (typeof paths)[number]

/** Limit management reads to the OFM owner's published read endpoints. */
export interface OfmOwnerApiReader {
  read(path: OfmOwnerReadPath): Promise<unknown>
}

/**
 * Use Connection's public login exchange before an ordinary admitted owner request.
 * @param ctx - Host effect scope providing the current Connection and WebServer.
 * @param timeoutMs - Positive timeout for authentication and the management read together.
 * @returns Host-only reader; unloading its scope aborts pending reads.
 */
export function createOfmOwnerApiReader(ctx: Context, timeoutMs: number): OfmOwnerApiReader {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw Error('OFM 连接读取超时配置无效')
  let closed = false
  const lifetime = new AbortController()
  ctx.effect(() => () => {
    closed = true
    lifetime.abort()
  })
  return {
    async read(path) {
      if (!paths.includes(path)) throw Error('OFM 连接读取路径无效')
      const connection = ctx.get('connection')
      const server = ctx.get('webServer')
      if (closed || !connection || !server) throw Error('OFM 连接读取服务未就绪')
      const host = server.host
      if (host !== '::1' && !/^127\.\d+\.\d+\.\d+$/.test(host))
        throw Error('OFM 连接读取仅支持本机监听地址')
      if (!Number.isInteger(server.port) || server.port < 1 || server.port > 65535)
        throw Error('OFM 连接读取监听尚未就绪')
      // rc.2 exposes host/port and only serves HTTP; newer listeners advertise TLS explicitly.
      const protocol = server.protocol === undefined ? 'http:' : server.protocol
      if (protocol !== 'http:' && protocol !== 'https:') throw Error('OFM 监听协议不受支持')
      const origin = new URL(`${protocol}//${host === '::1' ? '[::1]' : host}:${server.port}`)
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(timeoutMs)])
      // Cordis wraps each service read in a fresh caller-context proxy.
      const identity = (service: object | undefined) =>
        service && (Reflect.get(service, symbols.original) ?? service)
      const connectionOwner = identity(connection)
      const serverOwner = identity(server)
      const current = () => {
        if (
          closed ||
          signal.aborted ||
          identity(ctx.get('connection')) !== connectionOwner ||
          identity(ctx.get('webServer')) !== serverOwner
        )
          throw Error('OFM 连接读取已失效')
      }
      let stage = '生成认证地址'
      try {
        stage = '服务身份'
        current()
        stage = '认证地址解析'
        const login = new URL(connection.authenticatedUrl(new URL('/', origin).href))
        stage = '认证地址校验'
        if (login.origin !== origin.origin) {
          stage = '认证地址来源'
          throw Error('OFM 连接读取认证地址无效')
        }
        if (login.pathname !== '/') {
          stage = '认证地址路径'
          throw Error('OFM 连接读取认证地址无效')
        }
        if (login.username || login.password || login.hash) {
          stage = '认证地址凭据'
          throw Error('OFM 连接读取认证地址无效')
        }
        stage = '认证请求'
        const authenticated = await fetch(login, { redirect: 'manual', signal })
        stage = '认证回执'
        current()
        const cookies = authenticated.headers
          .getSetCookie()
          .map((cookie) => cookie.split(';', 1)[0])
        if (authenticated.body) await authenticated.body.cancel()
        current()
        if (![302, 303].includes(authenticated.status) || !cookies.length)
          throw Error('OFM 连接读取认证未完成')
        const location = authenticated.headers.get('location')
        if (!location || new URL(location, origin).origin !== origin.origin)
          throw Error('OFM 连接读取认证跳转无效')
        stage = '公开接口请求'
        const response = await fetch(new URL('/api/our-free-model' + path, origin), {
          headers: { cookie: cookies.join('; '), origin: origin.origin },
          redirect: 'error',
          signal,
        })
        stage = `公开接口回执 ${response.status}`
        current()
        if (!response.ok) {
          if (response.body) await response.body.cancel()
          throw Error('OFM 公开连接接口未就绪')
        }
        stage = '公开接口 JSON'
        const result: unknown = await response.json()
        current()
        return result
      } catch {
        // URLs, cookies and provider response bodies may contain credentials.
        throw Error(`OFM 公开连接读取失败（${stage}），请检查模型服务状态`)
      }
    },
  }
}
