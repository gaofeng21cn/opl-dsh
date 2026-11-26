/** The release must carry only OPL code and explicit official runtime peers. */
import { test } from 'node:test'
import { parse } from 'yaml'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { isBuiltin } from 'node:module'
import { fileURLToPath } from 'node:url'
const output = new URL('../dist/', import.meta.url)
test('tarball checksum and contents bind the installer to an external plugin', async () => {
  const manifest = JSON.parse(await readFile(new URL('artifact.json', output), 'utf8'))
  const bytes = await readFile(new URL(manifest.name, output))
  assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.sha256)
  // A Windows drive path is read by tar as a remote `host:path`, so list the bare asset name
  // from the dist directory instead of handing over an absolute path.
  const files = execFileSync('tar', ['-tzf', manifest.name], {
    cwd: fileURLToPath(output),
    encoding: 'utf8',
  })
  assert.doesNotMatch(files, /node_modules|app\.asar|credentials|\/\.env/)
  assert.doesNotMatch(files, /(?:^|\/)\._/m, 'macOS metadata must not become plugin resources')
  assert.ok(!files.includes('package/lib/zcode-harness-bridge.mjs'))
  for (const bridge of [
    'native-harness-bridge.mjs',
    'step-bridge.mjs',
    'pi-bridge.mjs',
    'zcode-ofm-bridge.mjs',
    'muse-bridge.mjs',
    'muse-bash-mcp.mjs',
    'muse-endpoint.mjs',
  ])
    assert.ok(files.includes(`package/lib/${bridge}`), `missing packaged bridge ${bridge}`)
  const overlay = parse(await readFile(new URL('package/cordis.patch.yml', output), 'utf8'))
  const web = overlay.find((entry) => entry.id === 'web')
  assert.equal(web?.config?.searchProvider, 'opl-gateway')
  assert.equal(web?.config?.fetchProvider, 'http')
  assert.equal(
    overlay.find((entry) => entry.id === 'llm-pi-ai'),
    undefined,
  )
  const overlayText = await readFile(new URL('package/cordis.patch.yml', output), 'utf8')
  assert.doesNotMatch(overlayText, /opl-gateway-(?:openai|auto-review|grok|gemini|kiro|aws|claude)/)
  const pkg = JSON.parse(await readFile(new URL('package/package.json', output), 'utf8'))
  assert.equal(pkg.name, '@one-person-lab/dsh-opl')
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-llm'], '*')
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-llm-pi-ai'], '*')
  const project = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.dependencies.zod, project.devDependencies.zod)
  assert.equal(pkg.peerDependencies.zod, undefined)
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json')
  assert.equal(pkg.exports['./icon'], pkg.icon)
  assert.ok(files.includes('package/' + pkg.icon.slice(2)))
  assert.deepEqual(
    await readFile(new URL('package/' + pkg.icon.slice(2), output)),
    await readFile(new URL('../' + project.icon.slice(2), import.meta.url)),
  )
  for (const language of ['zh', 'en']) {
    const resource = pkg.exports['./locale/*.json'].replace('*', language)
    const { meta } = JSON.parse(await readFile(new URL('package/' + resource.slice(2), output)))
    assert.equal(typeof meta.title, 'string')
    assert.notEqual(meta.title, pkg.name)
    assert.equal(typeof meta.description, 'string')
    assert.ok(files.includes('package/' + meta.detail))
    assert.ok(await readFile(new URL('package/' + meta.detail, output), 'utf8'))
  }
  assert.equal(manifest.version, manifest.officialVersion)
  assert.equal(manifest.updateProtocolVersion, 1)
  assert.equal(manifest.enhancementVersion, pkg.version)
  assert.equal(manifest.superagent, undefined)
  assert.equal(manifest.plugins, undefined)
  const code = await readFile(new URL('package/lib/index.js', output), 'utf8')
  assert.doesNotMatch(code, /api\.modelarts-maas\.com|HUAWEI_MAAS_API_KEY|oplContextBudget/)
  assert.match(code, /from "@deepseek-ai\/dsh-llm-deepseek"/)
  assert.doesNotMatch(
    code,
    /class LlmRuntime|class AgentLoop|resolveProfiles|credentialStoreFrom|authContextFrom|installGatewayModelCatalogProjection/,
  )
  const client = await readFile(new URL('package/lib/client.js', output), 'utf8')
  assert.doesNotMatch(
    client,
    /require\("@deepseek-ai\/dsh-typert-protocol\/remote-info"\)/,
    'the official Client loader does not materialize the protocol remote-info leaf',
  )
})

test('unified plugin owns execution, collaboration, and gateway lifecycles', async () => {
  const pkg = JSON.parse(await readFile(new URL('package/package.json', output), 'utf8'))
  assert.equal(pkg.name, '@one-person-lab/dsh-opl')
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-agent-preset-registry'], '*')
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-skill-filesystem'], '*')
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-tool-skill'], '*')
  const client = await readFile(new URL('package/lib/client.js', output), 'utf8')
  assert.ok(client.includes('id:"@one-person-lab/dsh-opl"'))
  const baseHost = await readFile(new URL('package/lib/index.js', output), 'utf8')
  assert.match(baseHost, /(?:class HarnessService|var HarnessService = class)\b/)
  assert.match(baseHost, /OfficialCollaborationBridge/)
  assert.match(baseHost, /DomainAgentPresetService/)
})

test('installer directory files match artifact payloadFiles exactly', async () => {
  const installerDir = fileURLToPath(new URL('OPL DSH 一键安装/', output))
  const manifest = JSON.parse(await readFile(join(installerDir, 'artifact.json'), 'utf8'))
  const actual = new Map()
  async function walk(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(join(directory, entry.name), relative)
      else actual.set(relative, await readFile(join(directory, entry.name)))
    }
  }
  await walk(installerDir)
  assert.ok(actual.has('artifact.json'))
  actual.delete('artifact.json')
  assert.deepEqual([...actual.keys()].sort(), Object.keys(manifest.payloadFiles).sort())
  assert.ok(Object.hasOwn(manifest.payloadFiles, 'installation-paths.d.mts'))
  assert.equal(Object.hasOwn(manifest.payloadFiles, 'cleanup-skill/quit-windows.ps1'), false)
  assert.equal(Object.hasOwn(manifest.payloadFiles, 'kimi-cu.mjs'), false)
  assert.equal(Object.hasOwn(manifest.payloadFiles, 'split-plugins.cjs'), false)
  for (const [relative, expected] of Object.entries(manifest.payloadFiles)) {
    const content = actual.get(relative)
    assert.ok(content, `missing installer payload file ${relative}`)
    assert.equal(createHash('sha256').update(content).digest('hex'), expected, relative)
  }
})

test('standalone installer and bridge scripts contain zero unbundled npm imports', async () => {
  const staticImport =
    /(?:^|[;\n])\s*(?:import|export)\s+(?:[^'"\n]+?\s+from\s+)?['"]([^'"]+)['"]/gm
  const cjsRequire = /(?<![`'"])\b(?:__)?require\(\s*['"]([^'"]+)['"]\s*\)/g
  const roots = [
    fileURLToPath(new URL('OPL DSH 一键安装/', output)),
    fileURLToPath(new URL('package/lib/', output)),
  ]
  const offenders = []
  async function inspectDir(directory, prefix = '', filterStandaloneOnly = false) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name)
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!filterStandaloneOnly) await inspectDir(full, rel, false)
        continue
      }
      if (!entry.name.endsWith('.mjs') && !entry.name.endsWith('.cjs')) continue
      if (filterStandaloneOnly && entry.name.endsWith('.js')) continue
      const source = await readFile(full, 'utf8')
      for (const pattern of [staticImport, cjsRequire]) {
        pattern.lastIndex = 0
        for (const match of source.matchAll(pattern)) {
          const spec = match[1]
          if (spec.startsWith('./') || spec.startsWith('../') || isBuiltin(spec)) continue
          offenders.push(`${rel} -> ${spec}`)
        }
      }
    }
  }
  await inspectDir(roots[0], 'installer', false)
  await inspectDir(roots[1], 'base-lib', true)
  assert.deepEqual(offenders, [], `Found unbundled bare imports:\n${offenders.join('\n')}`)
})
