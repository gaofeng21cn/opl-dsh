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

export function renderReleaseNotes(template, { version, officialVersion, sourceCommit }) {
  let notes = template
  for (const [key, value] of Object.entries({
    VERSION: version,
    OFFICIAL_VERSION: officialVersion,
    SOURCE_COMMIT: sourceCommit,
  }))
    notes = notes.replaceAll(`{{${key}}}`, value)
  notes = stripDuplicateReleaseHeading(notes, `OPL DSH v${version}`)
  if (notes.includes('{{') || !notes.startsWith('官方 DeepSeek Harness：'))
    throw Error('Release notes contain unresolved fields or are missing the joint version')
  return notes
}
