import type { HarnessProxy } from '../contracts/catalog.ts'

/** Validate persisted or RPC proxy settings without reflecting credential-bearing input. */
export function normalizeHarnessProxy(value: unknown): HarnessProxy | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('Harness 代理配置无效')
  const input = value as Record<string, unknown>
  if (input.mode === 'inherit' || input.mode === 'direct') return { mode: input.mode }
  if (input.mode !== 'custom' || typeof input.url !== 'string' || input.url.length > 2048)
    throw Error('Harness 代理配置无效')
  let url: URL
  try {
    url = new URL(input.url.trim())
  } catch {
    throw Error('代理地址须为不含账号密码的 HTTP 或 HTTPS 地址')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw Error('代理地址须为不含账号密码的 HTTP 或 HTTPS 地址')
  return { mode: 'custom', url: url.origin }
}

/** Resolve only a CLI child's proxy environment; never mutate Desktop's process environment. */
export function harnessProxyEnvironment(
  environment: NodeJS.ProcessEnv,
  proxy: HarnessProxy | undefined,
): NodeJS.ProcessEnv {
  const result = { ...environment }
  if (!proxy || proxy.mode === 'inherit') return result
  for (const key of Object.keys(result))
    if (['http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'].includes(key.toLowerCase()))
      delete result[key]
  if (proxy.mode === 'custom') {
    result.HTTP_PROXY = proxy.url
    result.HTTPS_PROXY = proxy.url
    // Local ACP/MCP bridges must remain local even when the CLI proxies its API requests.
    result.NO_PROXY = 'localhost,127.0.0.1,::1'
  }
  return result
}
