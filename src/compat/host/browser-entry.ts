import type { Context } from '@deepseek-ai/cordis'

/** Get a local login URL from the official desktop authentication provider. */
export function authenticatedEntry(ctx: Context, base: URL): string {
  const connection = ctx.get('connection') ?? ctx.connection
  if (typeof connection.authenticatedUrl === 'function')
    return connection.authenticatedUrl(base.href)
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
