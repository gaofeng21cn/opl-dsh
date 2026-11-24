import type { Context } from '@deepseek-ai/cordis'

/** Get a local login URL from the official desktop authentication provider. */
export function authenticatedEntry(ctx: Context, base: URL): string {
  const connection = ctx.get('connection') ?? ctx.connection
  // The authentication provider moved this helper out of its public service
  // type in the alpha runtime. Keep the runtime capability probe so the same
  // adapter works with both the released and alpha desktop hosts.
  const authenticatedUrl = Reflect.get(connection, 'authenticatedUrl')
  if (typeof authenticatedUrl === 'function') return authenticatedUrl.call(connection, base.href)
  const entries: { url: string; open?: boolean }[] = []
  type EntryEvent = (
    scope: Context['webServer'],
    event: 'webserver/entry-url',
    base: string,
    entries: { url: string; open?: boolean }[],
  ) => void
  ;(ctx.emit as unknown as EntryEvent)(ctx.webServer, 'webserver/entry-url', base.href, entries)
  for (const entry of entries) {
    if (!entry.open) continue
    const url = new URL(entry.url)
    if (
      url.origin === base.origin &&
      url.pathname === base.pathname &&
      !url.username &&
      !url.password &&
      url.searchParams.getAll('token').length === 1 &&
      url.searchParams.get('token')
    ) {
      url.hash = base.hash
      return url.href
    }
  }
  throw Error('官方桌面认证入口尚未就绪')
}
