/** GitHub already renders the release name above its Markdown body. */
export function stripDuplicateReleaseHeading(body, title) {
  const trimmed = body.trimStart()
  const newline = trimmed.indexOf('\n')
  const firstLine = (newline < 0 ? trimmed : trimmed.slice(0, newline)).trim()
  if (!/^#{1,6}\s+/.test(firstLine)) return body
  const heading = firstLine
    .replace(/^#{1,6}\s+/, '')
    .replace(/\s+#+$/, '')
    .trim()
  if (heading !== title) return body
  return newline < 0 ? '' : trimmed.slice(newline + 1).replace(/^(?:[ \t]*\r?\n)+/, '')
}

export function renderReleaseNotes(
  template,
  { version, officialVersion, officialVersions = {}, sourceCommit },
) {
  let notes = template
  for (const [key, value] of Object.entries({
    VERSION: version,
    OFFICIAL_VERSION: officialVersion,
    OFFICIAL_MAC_VERSION: officialVersions['mac-arm64'] ?? officialVersion,
    OFFICIAL_WINDOWS_VERSION: officialVersions['win-x64'] ?? officialVersion,
    SOURCE_COMMIT: sourceCommit,
  }))
    notes = notes.replaceAll(`{{${key}}}`, value)
  notes = stripDuplicateReleaseHeading(notes, `OPL DSH v${version}`)
  if (notes.includes('{{') || !notes.startsWith('官方 DeepSeek Harness：'))
    throw Error('Release notes contain unresolved fields or are missing the joint version')
  return notes
}

/* Only the original overview of the published 0.2.79 notes is eligible for replacement. */
export function backfill079Overview({ tag_name, body }) {
  if (tag_name !== 'opl-dsh-v0.2.79') throw Error('Expected the 0.2.79 release')
  return body.replace(
    /^(官方 DeepSeek Harness：`0\.2\.3-alpha\.2` · OPL 增强：`0\.2\.79`\r?\n\r?\n)本版更新内容见以下提交记录及对应功能文档。(?=\r?\n\r?\n### 变更(?:\r?\n|$))/,
    '$1本版适配官方 DSH 0.2.3-alpha.2。现在可以用 Google 账号登录 Antigravity 并选择账号可用的模型，打开模型列表也无需等待 Antigravity 完成模型发现。通用设置新增发行摘要，并修复了 Windows 上读取已有凭据时可能丢失凭据的问题。',
  )
}
