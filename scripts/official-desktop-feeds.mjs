/** The official desktop feeds select the runtime; development API pins stay separate. */
export const officialFeedUrls = {
  'mac-arm64': 'https://download.deepseek.com/dsh-desk/feeds/mac-arm64/nightly-mac.yml',
  'win-x64': 'https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml',
}
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const defaultMaxAttempts = 3
const defaultRetryDelayMs = 250
const transientStatus = (status) => status === 408 || status === 429 || status >= 500

const wait = (milliseconds) =>
  milliseconds > 0 ? new Promise((resolve) => setTimeout(resolve, milliseconds)) : undefined

function feedError(platform, url, detail, attempts) {
  const retry = attempts > 1 ? `；已尝试 ${attempts} 次` : ''
  return Error(`官方 ${platform} 更新清单读取失败（${detail}${retry}）：${url}`)
}

async function readFeed(platform, url, request, { maxAttempts, retryDelayMs, timeoutMs }) {
  let lastError
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response
    try {
      response = await request(url, { signal: AbortSignal.timeout(timeoutMs) })
    } catch (error) {
      lastError = error
      if (attempt === maxAttempts) {
        throw feedError(
          platform,
          url,
          `网络错误：${error instanceof Error ? error.message : String(error)}`,
          attempt,
        )
      }
      await wait(retryDelayMs)
      continue
    }
    if (!response.ok) {
      const detail = `HTTP ${response.status}`
      if (!transientStatus(response.status) || attempt === maxAttempts)
        throw feedError(platform, url, detail, attempt)
      lastError = Error(detail)
      await wait(retryDelayMs)
      continue
    }
    let text
    try {
      text = await response.text()
    } catch (error) {
      lastError = error
      if (attempt === maxAttempts) {
        throw feedError(
          platform,
          url,
          `网络错误：${error instanceof Error ? error.message : String(error)}`,
          attempt,
        )
      }
      await wait(retryDelayMs)
      continue
    }
    return text
  }
  throw feedError(
    platform,
    url,
    `网络错误：${lastError instanceof Error ? lastError.message : String(lastError)}`,
    maxAttempts,
  )
}

/**
 * Read both official desktop feeds and freeze one common runtime version.
 *
 * @param {typeof fetch} request HTTP request implementation, injectable for tests.
 * @param {{maxAttempts?: number, retryDelayMs?: number, timeoutMs?: number}} options Retry and timeout settings.
 * @returns {Promise<Record<string, {url: string, version: string, path: string, sha512: string}>>} Parsed feeds.
 */
export async function readOfficialDesktopFeeds(
  request = fetch,
  { maxAttempts = defaultMaxAttempts, retryDelayMs = defaultRetryDelayMs, timeoutMs = 30000 } = {},
) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1)
    throw Error('官方更新清单读取重试次数必须是正整数')
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0)
    throw Error('官方更新清单读取重试间隔必须是非负数')
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw Error('官方更新清单读取超时必须是正数')
  const results = await Promise.allSettled(
    Object.entries(officialFeedUrls).map(async ([platform, url]) => {
      const text = await readFeed(platform, url, request, {
        maxAttempts,
        retryDelayMs,
        timeoutMs,
      })
      const scalar = (name) => {
        const match = text.match(new RegExp(`^${name}:\\s*(?:>[-]?\\s*\\n\\s*)?([^\\r\\n]+)`, 'm'))
        if (!match) throw Error(`官方 ${platform} 更新清单缺少 ${name}：${url}`)
        return match[1].trim()
      }
      const feed = {
        url,
        version: scalar('version'),
        path: scalar('path'),
        sha512: scalar('sha512'),
      }
      if (
        !versionPattern.test(feed.version) ||
        !/^https:\/\//.test(feed.path) ||
        !/^[A-Za-z0-9+/]{86}==$/.test(feed.sha512)
      )
        throw Error(`官方 ${platform} 更新清单字段无效：${url}`)
      return [platform, feed]
    }),
  )
  const failed = results.find((result) => result.status === 'rejected')
  if (failed?.status === 'rejected') throw failed.reason
  const feeds = Object.fromEntries(
    results.map((result) => (result.status === 'fulfilled' ? result.value : [])),
  )
  const macVersion = feeds['mac-arm64'].version
  const windowsVersion = feeds['win-x64'].version
  if (macVersion !== windowsVersion)
    throw Error(
      `官方 mac-arm64 与 win-x64 清单版本不一致：mac-arm64=${macVersion}，win-x64=${windowsVersion}`,
    )
  return feeds
}
