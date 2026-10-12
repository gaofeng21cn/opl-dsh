import type { HarnessProxy } from '../../contracts/types.ts'
/** One external Harness's proxy row, as the settings page edits it. */
export type ProxyMode = 'inherit' | 'direct' | 'custom'
export interface ProxyDraft {
  mode: ProxyMode
  url: string
}
/** What the last save attempt on one row did, so the row never claims more than it knows. */
export interface ProxyOutcome {
  id: string
  ok: boolean
  message: string
}
/** An edited row is either persistable, or refused with a message that quotes no address. */
export type ProxyValue = { ok: true; value: HarnessProxy } | { ok: false; error: string }
export const PROXY_EXAMPLE = 'http://127.0.0.1:7897'
/** A missing proxy inherits the Desktop environment, exactly as the contract says. */
export function normalizeProxy(proxy: HarnessProxy | undefined): ProxyDraft {
  if (proxy?.mode === 'direct') return { mode: 'direct', url: '' }
  if (proxy?.mode === 'custom') return { mode: 'custom', url: proxy.url }
  return { mode: 'inherit', url: '' }
}
/**
 * Turn one edited row into the value to persist.
 *
 * Only a credential-free http/https URL is accepted. A proxy carrying a username or
 * password would be written into the catalog file and exported into the CLI's
 * environment, so it is refused here instead. Every message names what is wrong and
 * never quotes the address back, because a pasted proxy is itself something the user
 * may not want on screen.
 */
export function proxyFromDraft(draft: ProxyDraft): ProxyValue {
  if (draft.mode !== 'custom') return { ok: true, value: { mode: draft.mode } }
  const url = draft.url.trim()
  if (!url) return { ok: false, error: `请填写代理地址，示例 ${PROXY_EXAMPLE}` }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, error: `代理地址格式无效，示例 ${PROXY_EXAMPLE}` }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    return { ok: false, error: '仅支持 http:// 或 https:// 代理地址' }
  if (parsed.username || parsed.password)
    return { ok: false, error: '代理地址不能包含用户名或密码' }
  if (!parsed.hostname) return { ok: false, error: '代理地址缺少主机名' }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash || url.length > 2048)
    return { ok: false, error: '代理地址只接受主机和端口，不包含路径、查询或片段' }
  return { ok: true, value: { mode: 'custom', url: parsed.origin } }
}
/** A live hint for a half-typed address; silence until the user has actually typed. */
export function proxyDraftError(draft: ProxyDraft): string {
  if (draft.mode !== 'custom' || !draft.url.trim()) return ''
  const parsed = proxyFromDraft(draft)
  return parsed.ok ? '' : parsed.error
}
/** Mask any userinfo before an error reaches the page: a Host message may quote a URL. */
const URL_USERINFO = /(?:\b[a-z][a-z0-9+.-]*:)?\/\/[^/\s@]*@/gi
export function safeFailureMessage(cause: unknown, fallback = '保存失败'): string {
  const raw = cause instanceof Error && cause.message.trim() ? cause.message : fallback
  return raw.replace(URL_USERINFO, (userinfo) => userinfo.replace(/[^@]*@/, '***@')).slice(0, 300)
}
