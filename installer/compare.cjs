/** Compare versions via the bundled SemVer package both as CLI and when required. */
const semver = require('semver')

function parseVersion(value) {
  const text = String(value ?? '').trim()
  if (!/^\d/u.test(text)) return undefined
  const parsed = semver.parse(text)
  if (!parsed) return undefined
  return {
    major: parsed.major,
    minor: parsed.minor,
    patch: parsed.patch,
    prerelease: parsed.prerelease.map(String),
  }
}

function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) {
    const error = Error(`无效的 OFM 版本：${left} / ${right}`)
    error.code = 'invalid-ofm-version'
    throw error
  }
  return semver.compare(String(left).trim(), String(right).trim())
}

if (require.main === module) {
  const [_app, installed, available] = process.argv.slice(2)
  process.exitCode =
    semver.valid(installed) && semver.valid(available) && semver.gte(installed, available) ? 0 : 1
}

module.exports = {
  parseVersion,
  compareVersions,
}
