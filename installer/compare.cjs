/** Compare versions via the official SemVer package when run as CLI, or pure SemVer helpers when required. */
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u

function parseVersion(value) {
  const match = VERSION_PATTERN.exec(String(value ?? '').trim())
  if (!match) return undefined
  const prerelease = match[4] === undefined ? [] : match[4].split('.')
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
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
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index++) {
    const x = a.prerelease[index]
    const y = b.prerelease[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xNumber = /^\d+$/u.test(x)
    const yNumber = /^\d+$/u.test(y)
    if (xNumber && yNumber) return Number(x) > Number(y) ? 1 : -1
    if (xNumber !== yNumber) return xNumber ? -1 : 1
    return x > y ? 1 : -1
  }
  return 0
}

if (require.main === module) {
  const { createRequire } = require('node:module')
  const { join } = require('node:path')
  const [app, installed, available] = process.argv.slice(2)
  const resources = process.platform === 'win32' ? 'resources' : 'Contents/Resources'
  const runtime = createRequire(join(app, resources, 'app.asar/dsh/package.json'))
  const semver = runtime('semver')
  process.exitCode =
    semver.valid(installed) && semver.valid(available) && semver.gte(installed, available) ? 0 : 1
}

module.exports = {
  parseVersion,
  compareVersions,
}
