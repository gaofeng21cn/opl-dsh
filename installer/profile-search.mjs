/**
 * Keep the OPL Gateway search route in the official profile overlay.
 * @param {string} source - Profile patch YAML.
 * @returns {string} Profile patch YAML containing the Gateway search route.
 */
export function ensureGatewaySearchProvider(source) {
  const lines = source.split(/\r?\n/)
  const entries = []
  for (let index = 0; index < lines.length; index += 1)
    if (/^- id: /.test(lines[index])) entries.push(index)
  const webIndex = entries.find((index) => lines[index] === '- id: web')
  if (webIndex !== undefined) {
    const end = entries.find((index) => index > webIndex) ?? lines.length
    if (lines.slice(webIndex, end).some((line) => /^    searchProvider: /.test(line))) return source
    const config = lines.findIndex(
      (line, index) => index > webIndex && index < end && line === '  config:',
    )
    if (config >= 0) lines.splice(config + 1, 0, '    searchProvider: opl-gateway')
    else lines.splice(webIndex + 1, 0, '  config:', '    searchProvider: opl-gateway')
    return lines.join('\n')
  }
  const insertion = entries.find((index) => lines[index] === '- id: llm-pi-ai') ?? lines.length
  lines.splice(insertion, 0, '- id: web', '  config:', '    searchProvider: opl-gateway')
  return lines.join('\n')
}
