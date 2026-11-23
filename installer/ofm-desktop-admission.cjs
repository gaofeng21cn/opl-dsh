/** Temporary backport of Ebony-Vinyl/dsh-our-free-model#911 for the official Desktop. */
const { createHash, randomUUID } = require('node:crypto')
const { lstat, readFile, writeFile, rename, rm, realpath } = require('node:fs/promises')
const { join } = require('node:path')

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const versions = {
  '2.8.3': [
    [
      'e905f725e42c71b32bd0a7a6b87df85bff6d90c26403232e4c4372e692f83a42',
      '2a803e996fb1bc9b9ddeb9f7e29467887a0b11835d91c2e2e43489a987b6949e',
    ],
  ],
  // OFM published both a release archive and a different signed in-app update as 2.9.0.
  '2.9.0': [
    [
      '64bda1fa219cefdccbaea85b4737173a195b1e761aa3318950e590935578a5ac',
      'e8c0c2dc2c7e34ad8e513dd7956b3891533283a2c514f5a7093c466151f56e70',
    ],
    [
      '991a660d0e108bd6c1c3b6c2a1e21aa3147c63f549c33770dae384a5d665ff9d',
      '49ea4a47c767698ff833627a4ed2b572b0198c34c746990d42399ffc38747dad',
    ],
  ],
}
const trust = [
  '0c1f99a77264afe95432f15c6777d234a8f8f0d4cf7380e220c03c7e315da24d',
  '65249ec3bd32762624cd7a326758827e47e3f5067ca18d6be79a2ac01d67becd',
]
const edits = {
  'index.js': [
    [
      "    scoped.effect(() => server.register({ kind: 'prefix', path: '/api/our-free-model', handler: api }), 'our-free-model: api routes')\n",
      "    scoped.effect(() => server.register({ kind: 'prefix', path: '/api/our-free-model', auth: 'required', handler: api }), 'our-free-model: api routes')\n",
    ],
    [
      "    scoped.effect(() => server.register({ kind: 'exact', path: '/api/our-free-model/events', handler: eventsRoute }), 'our-free-model: events stream')\n",
      "    scoped.effect(() => server.register({ kind: 'exact', path: '/api/our-free-model/events', auth: 'required', handler: eventsRoute }), 'our-free-model: events stream')\n",
    ],
    [
      "  function eventsRoute(req, res) {\n    const rejection = rejectionFor(req, fenceConnection, logAdmissionRejection('events'))\n",
      "  function eventsRoute(req, res, peer) {\n    const rejection = rejectionFor(req, fenceConnection, logAdmissionRejection('events'), peer)\n",
    ],
    [
      '  return async function handler(req, res) {\n',
      '  return async function handler(req, res, peer) {\n',
    ],
    [
      '    const rejection = rejectionFor(req, deps.connection, deps.onAdmissionRejection)\n',
      '    const rejection = rejectionFor(req, deps.connection, deps.onAdmissionRejection, peer)\n',
    ],
  ],
  'src/trust.js': [
    [
      ' *   fixed diagnostic fields only; never request headers or error text\n',
      ' *   fixed diagnostic fields only; never request headers or error text\n * @param {object} [peer] - Peer supplied by the Host after authorizing this HTTP route.\n',
    ],
    [
      'export function rejectionFor(req, connection, onRejection) {\n',
      "export function rejectionFor(req, connection, onRejection, peer) {\n  // DSH 0.2.3 authorizes required routes before invoking their handlers.\n  if (peer !== undefined) {\n    if (peer?.principal?.kind === 'owner' && peer.signal?.aborted === false) return undefined\n    return 403\n  }\n",
    ],
  ],
}

async function replace(path, bytes, mode) {
  const stage = path + '.opl-' + randomUUID()
  try {
    await writeFile(stage, bytes, { flag: 'wx', mode })
    await rename(stage, path)
  } finally {
    await rm(stage, { force: true })
  }
}

/** Caller holds the stopped profile's OFM lock and has verified its self-managed link. */
async function applyDesktopAdmission(root, version) {
  const hashes = versions[version]
  if (!Array.isArray(hashes)) return 'unrecognized-version'
  const target = join(root, 'ofm', 'dsh-our-free-model')
  const canonical = await realpath(root)
  const changes = []
  const files = {}
  for (const [name, variants] of [
    ['src/trust.js', [trust]],
    ['index.js', hashes],
  ]) {
    const file = join(target, name)
    const stat = await lstat(file).catch((error) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (!stat) {
      console.warn('OFM 文件缺失，已保留当前安装：' + name)
      return 'modified'
    }
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (await realpath(file)) !== join(canonical, 'ofm', 'dsh-our-free-model', name)
    )
      throw Error('OFM 兼容文件路径无效：' + name)
    const bytes = await readFile(file)
    const actual = digest(bytes)
    const match = variants.find(([before, after]) => actual === before || actual === after)
    if (!match) {
      console.warn('已保留修改过的 OFM 文件，未应用桌面兼容修复：' + name)
      return 'modified'
    }
    const after = match[1]
    files[name] = after
    if (actual === after) continue
    let next = bytes.toString('utf8')
    for (const [oldText, newText] of edits[name]) next = next.replace(oldText, newText)
    if (digest(next) !== after) throw Error('OFM 兼容文件摘要不符：' + name)
    changes.push({ file, bytes, next, mode: stat.mode })
  }
  const applied = []
  try {
    for (const change of changes) {
      await replace(change.file, change.next, change.mode)
      applied.push(change)
    }
    const receipt = join(root, 'opl-ofm-desktop-admission.json')
    const record =
      JSON.stringify(
        {
          version,
          upstreamCommit: 'e684b64b3179c12d00d525493e14c3ea283ddf3e',
          files,
        },
        null,
        2,
      ) + '\n'
    await replace(receipt, record, 0o600)
  } catch (error) {
    for (const change of applied.reverse()) await replace(change.file, change.bytes, change.mode)
    throw error
  }
  return changes.length ? 'applied' : 'already-applied'
}
module.exports = { applyDesktopAdmission }
