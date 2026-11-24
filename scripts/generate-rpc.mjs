/** Rebuild the RPC contract from the real Host sources with official Typert. */
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { FaceModelEmitter, WorkspaceAnalyzer } from '@deepseek-ai/dsh-typert-generator'

const OUTPUT_FILES = ['host.mjs', 'host.d.mts', 'remote.mjs', 'remote.d.mts', 'remote.d.mts.map']

async function hasAllOutputs(directory) {
  for (const name of OUTPUT_FILES) {
    try {
      await stat(join(directory, name))
    } catch (error) {
      if (error.code === 'ENOENT') return false
      throw error
    }
  }
  return true
}

function emitOutputs(temporary, manifestName, checkDiagnostics) {
  const workspace = new WorkspaceAnalyzer({
    root: temporary,
    faces: ['host'],
    packages: [manifestName],
    checkDiagnostics,
  }).analyze()
  const host = workspace.faces.find((face) => face.face === 'host')
  if (!host)
    throw new Error(
      'Typert did not discover the Host package; check package exports and tsconfig.host.json',
    )
  const generated = new FaceModelEmitter(host).emit(manifestName)
  if (!generated.remote) throw new Error('Typert did not discover any @Remote methods')
  // Emitter paths assume package/lib. Our checked-in files live in
  // src/generated, so relocate only source-navigation metadata.
  const remoteMap = JSON.parse(generated.remote.dtsMap)
  remoteMap.file = 'remote.d.mts'
  remoteMap.sources = remoteMap.sources.map((source) => source.replace(/^\.\.\/src\//, '../'))
  return {
    'host.mjs': generated.js.replaceAll('"file":"packages/opl/', '"file":"'),
    'host.d.mts': generated.dts,
    'remote.mjs': generated.remote.js.replaceAll('"file":"packages/opl/', '"file":"'),
    'remote.d.mts': generated.remote.dts.replace(
      'sourceMappingURL=typert.remote-client.d.ts.map',
      'sourceMappingURL=remote.d.mts.map',
    ),
    'remote.d.mts.map': `${JSON.stringify(remoteMap)}\n`,
  }
}

async function newestMtimeNs(path, skipDirName) {
  let info
  try {
    info = await stat(path, { bigint: true })
  } catch (error) {
    if (error.code === 'ENOENT') return 0n
    throw error
  }
  if (!info.isDirectory()) return info.mtimeNs
  let newest = info.mtimeNs
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (skipDirName && entry.name === skipDirName) continue
    const child = await newestMtimeNs(join(path, entry.name))
    if (child > newest) newest = child
  }
  return newest
}

async function isRpcCurrent(root) {
  let oldestOutput = null
  for (const name of OUTPUT_FILES) {
    let info
    try {
      info = await stat(join(root, 'src/generated', name), { bigint: true })
    } catch (error) {
      if (error.code === 'ENOENT') return false
      throw error
    }
    if (oldestOutput === null || info.mtimeNs < oldestOutput) oldestOutput = info.mtimeNs
  }
  if (oldestOutput === null) return false
  const candidates = [
    newestMtimeNs(join(root, 'src'), 'generated'),
    newestMtimeNs(join(root, 'installer')),
    newestMtimeNs(join(root, 'package.json')),
    newestMtimeNs(fileURLToPath(import.meta.url)),
    newestMtimeNs(join(root, 'node_modules/@deepseek-ai/dsh-typert-protocol/package.json')),
    readdir(root)
      .then((names) =>
        Promise.all(
          names
            .filter((name) => /^tsconfig(?:\..+)?\.json$/.test(name))
            .map((name) => newestMtimeNs(join(root, name))),
        ),
      )
      .then((times) => times.reduce((max, item) => (item > max ? item : max), 0n)),
  ]
  const newestInput = (await Promise.all(candidates)).reduce(
    (max, item) => (item > max ? item : max),
    0n,
  )
  return newestInput < oldestOutput
}

export async function generateRpc({
  root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  check = false,
  ifStale = false,
  checkDiagnostics = true,
} = {}) {
  if (!check && ifStale && (await isRpcCurrent(root))) return [...OUTPUT_FILES]
  const temporary = await mkdtemp(join(tmpdir(), 'opl-dsh-typert-'))
  try {
    // The official analyzer registers packages only below workspace/packages.
    // Copy a disposable source snapshot rather than changing the repository shape
    // or monkey-patching its analyzer. No credentials or runtime data are copied.
    const packageRoot = join(temporary, 'packages', 'opl')
    await mkdir(packageRoot, { recursive: true })
    await cp(join(root, 'src'), join(packageRoot, 'src'), { recursive: true })
    await cp(join(root, 'installer'), join(packageRoot, 'installer'), {
      recursive: true,
    })
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify(manifest))
    for (const name of await readdir(root)) {
      if (/^tsconfig(?:\..+)?\.json$/.test(name))
        await cp(join(root, name), join(packageRoot, name))
    }
    await symlink(join(root, 'node_modules'), join(temporary, 'node_modules'), 'junction')
    const hostConfig = JSON.parse(await readFile(join(root, 'tsconfig.host.json'), 'utf8'))
    // Typert recognizes decorators by their registered package identity. Register
    // the installed protocol declarations unchanged; never emulate decorators.
    const protocolRoot = join(temporary, 'packages', 'protocol')
    await cp(join(root, 'node_modules/@deepseek-ai/dsh-typert-protocol'), protocolRoot, {
      recursive: true,
      dereference: true,
    })
    await writeFile(
      join(protocolRoot, 'tsconfig.json'),
      JSON.stringify({ files: ['lib/types/index.d.ts'] }),
    )
    const compilerOptions = {
      ...hostConfig.compilerOptions,
      paths: {
        ...hostConfig.compilerOptions.paths,
        '@deepseek-ai/dsh-typert-protocol': [join(protocolRoot, 'lib/types/index.d.ts')],
      },
    }
    await writeFile(
      join(packageRoot, 'tsconfig.host.json'),
      JSON.stringify({ ...hostConfig, compilerOptions }),
    )
    await writeFile(
      join(temporary, 'tsconfig.host.json'),
      JSON.stringify({
        compilerOptions,
        files: [],
        references: [
          { path: './packages/opl/tsconfig.host.json' },
          { path: './packages/protocol/tsconfig.json' },
        ],
      }),
    )
    if (!check && checkDiagnostics && !(await hasAllOutputs(join(packageRoot, 'src/generated')))) {
      const bootstrapOutputs = emitOutputs(temporary, manifest.name, false)
      await mkdir(join(packageRoot, 'src/generated'), { recursive: true })
      for (const [name, content] of Object.entries(bootstrapOutputs)) {
        await writeFile(join(packageRoot, 'src/generated', name), content)
      }
    }
    const outputs = emitOutputs(temporary, manifest.name, checkDiagnostics)
    const drift = []
    if (!check) await mkdir(join(root, 'src/generated'), { recursive: true })
    for (const [name, content] of Object.entries(outputs)) {
      const path = join(root, 'src/generated', name)
      if (check) {
        const current = await readFile(path, 'utf8').catch((error) => {
          if (error.code === 'ENOENT') return undefined
          throw error
        })
        if (current !== content) drift.push(name)
      } else await writeFile(path, content)
    }
    if (drift.length)
      throw new Error(`RPC generation drift: ${drift.join(', ')}. Run npm run generate:rpc.`)
    return Object.keys(outputs)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        check: { type: 'boolean', default: false },
        'if-stale': { type: 'boolean', default: false },
        'skip-typecheck': { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    })
    const check = values.check
    const ifStale = values['if-stale']
    if (check && ifStale) throw new Error('Cannot combine --check and --if-stale')
    await generateRpc({
      check,
      ifStale,
      checkDiagnostics: !values['skip-typecheck'],
    })
    console.log(
      check
        ? 'RPC generated files are current.'
        : 'RPC contracts generated from Host @Remote declarations.',
    )
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
