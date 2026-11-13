const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const stableVersion = /^\d+\.\d+\.\d+$/
const feedSha512 = /^[A-Za-z0-9+/]{86}==$/

export function officialPlatformKey(platform = process.platform, arch = process.arch) {
  if (platform === 'darwin' && arch === 'arm64') return 'mac-arm64'
  if (platform === 'win32' && arch === 'x64') return 'win-x64'
  return null
}

/** Select the official runtime version for the current platform. */
export function officialVersionForPlatform(
  manifest,
  platform = process.platform,
  arch = process.arch,
) {
  const key = officialPlatformKey(platform, arch)
  return manifest?.official?.feeds?.[key]?.version ?? manifest?.official?.version
}

export function validateReleaseManifest(
  manifest,
  { tagName, assetName, requireMatchingOfficialFeeds = false } = {},
) {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.channel !== 'stable')
    throw new Error('发布清单不是稳定版清单')
  if (!stableVersion.test(manifest.releaseVersion)) throw new Error('发布版本无效')
  if (manifest.tagName !== `opl-dsh-v${manifest.releaseVersion}`)
    throw new Error('清单 tag 与版本不符')
  if (tagName && tagName !== `opl-dsh-v${manifest.releaseVersion}`)
    throw new Error('发布 tag 与清单版本不符')
  if (!manifest.official || !semver.test(manifest.official.version))
    throw new Error('官方 DSH 版本无效')
  if (manifest.official.feeds !== undefined) {
    const feeds = manifest.official.feeds
    if (
      !feeds ||
      typeof feeds !== 'object' ||
      Array.isArray(feeds) ||
      !['mac-arm64', 'win-x64'].every((key) => feeds[key]) ||
      Object.keys(feeds).some((key) => !['mac-arm64', 'win-x64'].includes(key))
    )
      throw new Error('官方 DSH feed 清单不完整')
    for (const feed of Object.values(feeds)) {
      if (
        !feed ||
        !semver.test(feed.version) ||
        typeof feed.url !== 'string' ||
        !/^https:\/\//.test(feed.url) ||
        typeof feed.path !== 'string' ||
        !/^https:\/\//.test(feed.path) ||
        typeof feed.sha512 !== 'string' ||
        !feedSha512.test(feed.sha512)
      )
        throw new Error('官方 DSH feed 字段无效')
    }
    if (feeds['mac-arm64'].version !== manifest.official.version)
      throw new Error('官方主版本必须来自 macOS feed')
    if (requireMatchingOfficialFeeds && feeds['win-x64'].version !== feeds['mac-arm64'].version)
      throw new Error('官方 macOS 与 Windows feed 版本必须一致')
  }
  if (!manifest.enhancement || !stableVersion.test(manifest.enhancement.version))
    throw new Error('OPL 增强版本无效')
  if (manifest.enhancement.version !== manifest.releaseVersion)
    throw new Error('联合版本与增强版本不符')
  if (assetName && manifest.enhancement.asset !== assetName) throw new Error('增强资产与清单不符')
  if (!/^sha256:[a-f0-9]{64}$/.test(manifest.enhancement.sha256))
    throw new Error('增强资产摘要无效')
  if (!Number.isSafeInteger(manifest.enhancement.size) || manifest.enhancement.size <= 0)
    throw new Error('增强资产大小无效')
  return manifest
}
