/** Enforce runtime ownership and Phase 0 v2 architectural redlines. */
import { readdir, readFile } from 'node:fs/promises'
import { dirname, extname, relative, resolve } from 'node:path'
import * as ts from 'typescript/unstable/ast'
import { withTypeScriptSources } from './lib/typescript-source.mjs'
const repoRoot = resolve(import.meta.dirname, '..')
const root = resolve(repoRoot, 'src')
async function collectFiles(directory, extensions, skipGenerated = false) {
  const found = []
  let entries = []
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return found
  }
  for (const item of entries) {
    if (skipGenerated && item.name === 'generated') continue
    const path = resolve(directory, item.name)
    if (item.isDirectory()) found.push(...(await collectFiles(path, extensions, skipGenerated)))
    else if (extensions.includes(extname(path))) found.push(path)
  }
  return found
}
const errors = []
const sourcePaths = await collectFiles(root, ['.ts', '.tsx'], true)
withTypeScriptSources(sourcePaths, (sourceFile) => {
  for (const path of sourcePaths) {
    const name = relative(root, path).replaceAll('\\', '/')
    const source = sourceFile(path)
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue
      if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue
      const specifier = statement.moduleSpecifier.text
      if (!specifier.startsWith('.')) continue
      const target = relative(root, resolve(dirname(path), specifier)).replaceAll('\\', '/')
      const typeOnly = ts.isImportDeclaration(statement)
        ? statement.importClause?.isTypeOnly === true
        : statement.isTypeOnly === true
      if (name.includes('/client/') && target.includes('/host/') && !typeOnly)
        errors.push(`${name}: browser runtime imports Host implementation ${target}`)
      if (name.startsWith('gateway/') && /^(execution|collaboration)\//.test(target))
        errors.push(`${name}: Gateway depends on execution/collaboration ${target}`)
      if (name.startsWith('setup/') && /^(execution|collaboration)\//.test(target))
        errors.push(`${name}: onboarding owns another capability ${target}`)
      if (!name.startsWith('suite/') && target.startsWith('suite/') && !typeOnly)
        errors.push(`${name}: feature depends on its assembly ${target}`)
    }
  }
})

const runtimeAntipatterns = [
  'fiber.runtime.Config',
  'fiber.restart',
  'Object.defineProperty(credentials',
  'installGatewayModelPresentation',
  'data-opl-internal-provider',
  "Object.defineProperty(controller, 'modelCatalog'",
  'opl-model-navigation',
  'followEngineUpdates',
]
const retiredModuleTokens = [
  'kimi-cu',
  'src/auto-review',
  'auto-review/host',
  'auto-review/client',
  'dsh-superagent',
  'build-feature-plugins',
  'split-plugins',
  'legacy-channel',
  'cleanup-skill',
  'step-bridge',
  'muse-bridge',
  'zcode-ofm',
  'adapters/step',
  'adapters/muse',
  'adapters/pool',
  'adapters/zcode-ofm',
  'adapters/zcode-protocol',
  'adapters/mimo',
]
for (const path of sourcePaths) {
  const name = relative(repoRoot, path).replaceAll('\\', '/')
  const content = await readFile(path, 'utf8')
  for (const token of runtimeAntipatterns) {
    if (content.includes(token)) errors.push(`${name}: forbidden runtime anti-pattern ${token}`)
  }
  for (const token of retiredModuleTokens) {
    if (content.includes(token)) errors.push(`${name}: forbidden retired module reference ${token}`)
  }
  if (name !== 'src/execution/host/catalog.ts' && content.includes('mimo-code')) {
    errors.push(`${name}: forbidden retired module reference mimo-code`)
  }
}
const infraPaths = [
  ...(await collectFiles(resolve(repoRoot, 'installer'), ['.js', '.mjs', '.cjs', '.ts'])),
  ...(await collectFiles(resolve(repoRoot, 'scripts'), ['.js', '.mjs', '.cjs', '.ts'])),
].filter(
  (path) =>
    relative(repoRoot, path).replaceAll('\\', '/') !== 'scripts/check-module-boundaries.mjs',
)
for (const path of infraPaths) {
  const name = relative(repoRoot, path).replaceAll('\\', '/')
  const content = await readFile(path, 'utf8')
  for (const token of retiredModuleTokens) {
    if (content.includes(token)) errors.push(`${name}: forbidden retired module reference ${token}`)
  }
}
if (errors.length) throw Error(errors.join('\n'))
console.log('Module ownership boundaries verified')
