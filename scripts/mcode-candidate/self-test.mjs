#!/usr/bin/env node
/**
 * 用合成路径验证候选脚本的边界，并真实驱动两个入口的命令行。
 *
 * 覆盖：入口守卫在创建输出前生效；带空格的路径与 Windows `.cmd` shim 可执行；
 * 与受保护目录在任意方向重叠都被拒绝（含符号链接祖先）；已有输出目录必须显式
 * --replace 且旧目录只改名保留；归档条目越界被拒；凭据植入被拒；能力标记不得靠空集合
 * 蒙混；清单路径必须相对且不逃逸、并且覆盖候选目录里的每个文件；许可布局与验证器一致；
 * mcode-tools 归档被放进官方构建真正读取的缓存位置。
 *
 * 提供 --source-archive 时还会对官方归档做真实解包与真实 apply，并用工具链替身把
 * 「构建入口 → 组装 → 验证入口」整条编排跑通一次。替身产物一律被判为不可分发。
 *
 * 用法：node scripts/mcode-candidate/self-test.mjs --out <独占目录> [--source-archive <tar.gz>]
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  assertRelativeInside,
  assertNotProtected,
  assertSafeArchiveEntries,
  assertWritableTarget,
  mkdirp,
  plan,
  resolveThroughExistingAncestors,
  resolveCommandPath,
  run,
  scriptDir,
  sha256File,
  writeJson,
} from './shared.mjs'
import {
  applyPatches,
  assertSupportedSource,
  copyExternalModules,
  detectCapabilities,
  extractOfficialSource,
  launcherContent,
  licenseTargets,
  prefetchMcodeTools,
  prepareOutputRoot,
  scanForCredentials,
  stageLicenses,
  stampVersion,
  verifyExternalModuleClosure,
  writeManifest,
} from './pipeline.mjs'
import { verifyCandidate } from './verify-candidate.mjs'

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    'source-archive': { type: 'string' },
    'tools-archive': { type: 'string' },
  },
})
if (!values.out) throw new Error('必须提供 --out <独占目录>。')
const base = resolve(values.out)
mkdirSync(base, { recursive: true })
const results = []
const pending = []
// 所有检查只在自己的随机合成目录里进行，不使用也不写入任何真实账号目录。
const scratch = (name) => mkdtempSync(join(base, `${name}-`))

const record = (name, ok, detail = '', kind = 'behavior') =>
  results.push({ name, kind, ok, detail: String(detail).slice(0, 2000) })

const expectThrow = (name, fragment, action) => {
  try {
    action()
    record(name, false, '应当拒绝但执行成功')
  } catch (error) {
    record(name, String(error.message).includes(fragment), error.message.split('\n')[0])
  }
}

const expectOk = (name, action) => {
  try {
    const detail = action()
    if (detail && typeof detail.then === 'function') {
      pending.push(
        detail.then(
          (value) => record(name, true, typeof value === 'string' ? value : ''),
          (error) => record(name, false, error.message.split('\n')[0]),
        ),
      )
      return
    }
    record(name, true, typeof detail === 'string' ? detail : '')
  } catch (error) {
    record(name, false, error.message.split('\n')[0])
  }
}

const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, 'utf8')
}

/** 运行真实入口的命令行，返回退出码与输出；入口失败也要拿到错误文本。 */
function runEntry(script, args) {
  try {
    const stdout = execFileSync(process.execPath, [join(scriptDir, script), ...args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    return { code: 0, stdout, stderr: '' }
  } catch (error) {
    // 入口自身抛出的异常也要可见，不能被压成空输出。
    return {
      code: error.status ?? 1,
      stdout: String(error.stdout ?? ''),
      stderr: `${String(error.stderr ?? '')}${
        error.stderr
          ? ''
          : `
${error.message}`
      }`,
    }
  }
}

/** 合成官方源码骨架：只包含版本闸门和版本号写入真正读到的文件。 */
function syntheticSource(
  root,
  version = plan.official.version,
  revision = plan.official.extractedSourceRevision,
) {
  write(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'minimax-code', version }, null, 2)}\n`,
  )
  write(
    join(root, 'packages/tui/package.json'),
    `${JSON.stringify({ name: '@minimax-ai/tui', version }, null, 2)}\n`,
  )
  write(
    join(root, 'release/extraction.json'),
    `${JSON.stringify({ sourceRevision: revision }, null, 2)}\n`,
  )
  return root
}

// 1. 路径含空格：版本号写入两处一致，启动器引用带空格的运行时且加引号。
const spaced = scratch('spaced path')
const spacedSource = syntheticSource(join(spaced, 'src'))
expectOk('space-path: stamp-version', () => {
  stampVersion(spacedSource, plan.candidateVersion)
  const root = JSON.parse(readFileSync(join(spacedSource, 'package.json'), 'utf8'))
  const tui = JSON.parse(readFileSync(join(spacedSource, 'packages/tui/package.json'), 'utf8'))
  if (root.version !== tui.version) throw new Error('两处清单版本不一致')
  return root.version
})
expectOk('space-path: launcher-quotes-runtime', () =>
  launcherContent('C:/Program Files/nodejs/node.exe').includes('"C:/Program Files/nodejs/node.exe"')
    ? '绝对运行时路径带空格且已加引号'
    : '',
)

// 2. 版本号必须显式并带候选后缀。
expectThrow('version: reject-official-version', '候选版本号必须', () =>
  stampVersion(spacedSource, plan.official.version),
)
expectThrow('version: reject-other-base', '必须以官方版本', () =>
  stampVersion(spacedSource, '0.7.0-opl-bash.20261010.1'),
)

// 3. 来源版本或内部源码修订不是复核过的官方值时拒绝打补丁。
expectThrow('source: reject-newer-official', '拒绝应用本补丁', () =>
  assertSupportedSource(syntheticSource(join(spaced, 'future'), '0.7.0')),
)
expectThrow('source: reject-other-revision', '拒绝应用本补丁', () =>
  assertSupportedSource(
    syntheticSource(join(spaced, 'revision'), plan.official.version, 'deadbee0'),
  ),
)

// 4. 受保护目录：内部、祖先、后代都拒绝；符号链接祖先按真实路径规范化。
const fakeHome = join(scratch('fake home'), 'home')
const realHome = process.env.USERPROFILE
mkdirSync(join(fakeHome, '.minimax-code'), { recursive: true })
mkdirSync(join(fakeHome, '.dsh'), { recursive: true })
process.env.USERPROFILE = fakeHome
process.env.HOME = fakeHome
expectThrow('protected: reject-inside', '重叠', () =>
  prepareOutputRoot(join(fakeHome, '.minimax-code'), { replace: true }),
)
expectThrow('protected: reject-ancestor', '重叠', () =>
  prepareOutputRoot(fakeHome, { replace: true }),
)
expectThrow('protected: reject-descendant', '重叠', () =>
  prepareOutputRoot(join(fakeHome, '.dsh', 'candidate build'), { replace: true }),
)
expectThrow('protected: reject-opl-profile', '重叠', () =>
  prepareOutputRoot(join(fakeHome, '.dsh'), { replace: true }),
)
expectOk('protected: symlink-ancestor-normalized', () => {
  const linked = join(fakeHome, 'linked')
  symlinkSync(fakeHome, linked, 'junction')
  const resolved = resolveThroughExistingAncestors(join(linked, 'build output'))
  if (resolved.startsWith(linked)) throw new Error(`未规范化：${resolved}`)
  return `规范化为 ${resolved}`
})
expectThrow('protected: reject-through-symlink', '重叠', () =>
  prepareOutputRoot(join(fakeHome, 'linked', '.minimax-code', 'build'), { replace: true }),
)
expectThrow('protected: reject-dangling-junction', '无法解析现存祖先', () => {
  const dangling = join(fakeHome, 'dangling')
  symlinkSync(join(fakeHome, 'missing'), dangling, 'junction')
  resolveThroughExistingAncestors(join(dangling, 'output'))
})
if (process.platform === 'win32') {
  expectOk('protected: installed-cmd-on-path-refused', () => {
    const installed = mkdirp(join(fakeHome, 'official install'))
    const launcher = join(installed, 'mcode.cmd')
    write(launcher, '@echo off\r\n')
    const env = { ...process.env, PATH: installed, PATHEXT: '.COM;.EXE;.BAT;.CMD' }
    if (resolveCommandPath('mcode.cmd', env) !== launcher)
      throw new Error('已带扩展名的 mcode.cmd 未按 PATH 解析')
    let refused = false
    try {
      assertNotProtected(join(installed, 'output'), env)
    } catch (error) {
      refused = error.message.includes('重叠')
    }
    if (!refused) throw new Error('官方安装目录未被保护')
    return '已带扩展名的启动器可解析，输出被拒绝'
  })
}
expectOk(
  'protected: allow-unrelated-dir',
  () => prepareOutputRoot(join(spaced, 'build output')).root,
)
if (realHome === undefined) delete process.env.USERPROFILE
else process.env.USERPROFILE = realHome

// 5. 已有输出目录必须显式 --replace，旧目录只改名保留、内容不丢。
const existing = join(scratch('existing'), 'output')
write(join(existing, 'keep.txt'), 'keep', 'utf8')
expectThrow('output: refuse-existing', '输出目录已存在', () =>
  prepareOutputRoot(existing, { replace: false }),
)
expectOk('output: replace-keeps-previous', () => {
  const out = prepareOutputRoot(existing, { replace: true })
  if (!out.replaced || !readdirSync(out.replaced).includes('keep.txt'))
    throw new Error('旧目录未被完整保留')
  return `保留为 ${basenameOf(out.replaced)}`
})

// 6. Windows `.cmd` shim：pnpm 就是这种形式，经 run() 与 cmd.exe 逐字送达，含空格路径不丢。
const binDir = join(scratch('shim bin'), 'fake package manager')
mkdirSync(binDir, { recursive: true })
write(
  join(binDir, 'record.cjs'),
  "require('node:fs').writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3), null, 2))\n",
)
write(
  join(binDir, 'stub-pkg.cmd'),
  [
    '@ECHO off',
    'REM 模拟 pnpm.cmd：把收到的参数逐字交给 Node 记录',
    'node "%~dp0record.cjs" "%~dp0argv.json" %*',
    'EXIT /B %ERRORLEVEL%',
    '',
  ].join('\r\n'),
)
expectOk('windows-cmd-shim: executes-argv-verbatim', () => {
  const argvFile = join(binDir, 'argv.json')
  const output = run(['stub-pkg', 'install', '--frozen-lockfile', 'C:/some dir/with spaces'], {
    env: withPath(binDir),
  })
  void output
  const received = JSON.parse(readFileSync(argvFile, 'utf8'))
  const expected = ['install', '--frozen-lockfile', 'C:/some dir/with spaces']
  if (JSON.stringify(received) !== JSON.stringify(expected))
    throw new Error(`argv 未逐字送达：${JSON.stringify(received)}`)
  return `收到 ${JSON.stringify(received)}`
})
expectOk('windows-cmd-shim: missing-command-fails', () => {
  expectThrow('windows-cmd-shim: missing-command-fails-inner', '命令失败', () =>
    run(['definitely-not-installed-pkg', '--version'], {}),
  )
  return '缺失的命令按失败处理'
})

// 7. 归档条目预检。
expectThrow('archive: reject-traversal', '不安全条目', () =>
  assertSafeArchiveEntries(['root/../../escape.txt']),
)
expectThrow('archive: reject-drive-letter', '不安全条目', () =>
  assertSafeArchiveEntries(['C:/x.ini']),
)
expectOk('archive: accept-normal', () => `接受 ${assertSafeArchiveEntries(['root/a/b.txt'])} 条`)

// 8. 清单路径必须是相对且不逃逸的。
expectThrow('manifest-path: reject-absolute', '相对路径', () => assertRelativeInside('C:/x.json'))
expectThrow('manifest-path: reject-escape', '逃出候选目录', () => assertRelativeInside('../x.json'))

// 9. 凭据扫描：官方账号数据出现在候选目录里即失败。
const credDir = scratch('credential probe')
write(join(credDir, '.minimax', 'auth'), '{"token":"placeholder"}', 'utf8')
expectThrow('credentials: reject-official-auth', '凭据或账号数据', () =>
  scanForCredentials(credDir),
)
expectOk('credentials: accept-clean-tree', () => scanForCredentials(spacedSource))

// 10. 能力标记：空 bundle 不得因为空集合而蒙混过关。
const emptyBundle = scratch('empty bundle')
mkdirSync(join(emptyBundle, 'chunks'), { recursive: true })
expectOk('capability: empty-bundle-fails', () => {
  const report = detectCapabilities(emptyBundle)
  if (report.markersPresent) throw new Error('空 bundle 不得判定为通过')
  return `markersPresent=${report.markersPresent} bundleScanned=${report.bundleScanned}`
})
const markedBundle = scratch('marked bundle')
write(join(markedBundle, 'chunks', 'main.js'), 'MCODE_SHELL_PATH; minimax-code/shell;')
expectOk('capability: markers-detected', () => {
  const report = detectCapabilities(markedBundle)
  if (!report.markersPresent) throw new Error('标记未识别')
  return JSON.stringify(report.bundleMarkers)
})

// 11. 许可布局：组装与验证器必须用同一份位置。
const licenseRoot = syntheticSource(join(scratch('licenses'), 'src'))
for (const file of plan.license.rootFiles) write(join(licenseRoot, file), 'license\n')
for (const file of plan.license.extraFiles) write(join(licenseRoot, file), 'license\n')
expectOk('licenses: staged-layout-matches-verifier', () => {
  const stageDir = mkdirp(join(scratch('licenses'), 'stage'))
  const staged = stageLicenses(licenseRoot, stageDir).map((entry) => entry.to)
  const expected = licenseTargets()
  const missing = expected.filter((file) => !staged.includes(file))
  if (missing.length) throw new Error(`组装缺少：${missing.join(', ')}`)
  if (staged.some((file) => !licenseTargets().includes(file)))
    throw new Error('组装写入了验证器不检查的位置')
  return staged.join(' ')
})

// 12. 外部模块：解引用复制，并如实报告未解析的传递依赖。
const moduleTree = scratch('modules')
const moduleSource = mkdirp(join(moduleTree, 'src', 'node_modules', 'fake-mod'))
write(
  join(moduleSource, 'package.json'),
  `${JSON.stringify({ name: 'fake-mod', version: '1.0.0', dependencies: { absent: '1.0.0' } })}\n`,
)
write(join(moduleSource, 'index.js'), '// fake\n')
expectOk('modules: unresolved-dependency-reported', () => {
  const candidateDir = mkdirp(join(moduleTree, 'candidate'))
  const result = copyExternalModules(join(moduleTree, 'src'), candidateDir, ['fake-mod'])
  if (!result.unresolved.some((item) => item.includes('absent')))
    throw new Error(`未报告缺失传递依赖：${JSON.stringify(result)}`)
  return result.unresolved.join(' ')
})

// 13. mcode-tools 预取：必须落到官方构建脚本真正读取的缓存位置。
if (values['tools-archive'] && existsSync(resolve(values['tools-archive']))) {
  const prefetchRoot = mkdirp(join(scratch('prefetch'), 'src'))
  const downloads = mkdirp(join(scratch('prefetch'), 'downloads'))
  const localCopy = async (url, destination, expectation, trace, label) => {
    const bytes = readFileSync(resolve(values['tools-archive']))
    const observed = {
      bytes: bytes.length,
      sha256: plan.mcodeToolsArtifact.sha256,
      integritySha512: expectation.integritySha512,
    }
    writeFileSync(destination, bytes)
    void observed
    return observed
  }
  expectOk('prefetch: writes-official-cache-path', async () => {
    const result = await prefetchMcodeTools(prefetchRoot, downloads, null, localCopy)
    const cached = join(prefetchRoot, plan.mcodeToolsArtifact.cachePath)
    if (!existsSync(cached))
      throw new Error(`未写入官方缓存位置：${plan.mcodeToolsArtifact.cachePath}`)
    return `缓存 ${cached.split(/[\\/]/).slice(-3).join('/')}（${result.sha256.slice(0, 12)}）`
  })
} else {
  record('prefetch: writes-official-cache-path', false, '未提供 --tools-archive', 'skipped')
}

// 14. 合成候选目录 → 验证器通过；改动摘要、补登记文件与启动器都能被发现。
const syntheticCandidate = join(scratch('candidate'), 'synthetic candidate dir')
write(
  join(syntheticCandidate, 'cli.js'),
  'console.log(process.env.OPL_STUB_VERSION || "0.6.3-opl-bash.20261010.1")\n',
)
write(join(syntheticCandidate, 'package.json'), `${JSON.stringify({ name: '@minimax-ai/code' })}\n`)
write(join(syntheticCandidate, 'CANDIDATE.md'), '# MiniMax Bash candidate\n')
write(join(syntheticCandidate, plan.launcher.windows), launcherContent(undefined))
write(join(syntheticCandidate, 'chunks', 'main.js'), 'MCODE_SHELL_PATH; minimax-code/shell;')
for (const file of licenseTargets()) write(join(syntheticCandidate, file), 'license\n')
for (const name of plan.build.externalModules)
  write(join(syntheticCandidate, 'node_modules', ...name.split('/'), 'package.json'), '{}\n')
writeManifest(syntheticCandidate, join(syntheticCandidate, 'manifest.json'), {
  version: plan.candidateVersion,
  nodeRuntime: { path: 'system-node', version: process.version, sha256: null },
  toolchainStubbed: false,
  externalModules: { copied: plan.build.externalModules, unresolved: [] },
})
const verifyReports = mkdirp(join(scratch('verify'), 'reports'))
expectOk('verify: synthetic-candidate-passes', () => {
  const report = verifyCandidate(syntheticCandidate, verifyReports)
  if (report.failed.length) throw new Error(`应通过但失败：${report.failed.join(', ')}`)
  return `${report.passed} 项通过，smoke=${report.isolatedEntrySmoke.ran ? report.isolatedEntrySmoke.version : '未运行'}`
})
expectOk('verify: failed-smoke-records-execution-attempt', () => {
  const cliPath = join(syntheticCandidate, 'cli.js')
  const original = readFileSync(cliPath, 'utf8')
  const manifestPath = join(syntheticCandidate, 'manifest.json')
  const originalManifest = readFileSync(manifestPath, 'utf8')
  try {
    write(cliPath, 'process.exitCode = 7\n')
    const manifest = JSON.parse(originalManifest)
    manifest.files.find((entry) => entry.file === 'cli.js').sha256 = sha256File(cliPath)
    write(manifestPath, JSON.stringify(manifest) + '\n')
    const report = verifyCandidate(syntheticCandidate, verifyReports)
    if (
      !report.failed.includes('isolated-entry-smoke') ||
      !report.executionGate.candidateCodeExecuted
    )
      throw new Error('已执行且失败的入口被记为未执行')
    return '退出非零仍如实记录已尝试执行'
  } finally {
    write(cliPath, original)
    write(manifestPath, originalManifest)
  }
})
expectOk('verify: tampered-file-detected', () => {
  write(join(syntheticCandidate, 'cli.js'), 'console.log("tampered")\n')
  const report = verifyCandidate(syntheticCandidate, verifyReports)
  if (!report.failed.includes('manifest-digests')) throw new Error('改动文件未被摘要检查发现')
  return `失败项：${report.failed.join(', ')}`
})
expectOk('verify: undeclared-file-detected', () => {
  write(
    join(syntheticCandidate, 'cli.js'),
    'console.log(process.env.OPL_STUB_VERSION || "0.6.3-opl-bash.20261010.1")\n',
  )
  write(join(syntheticCandidate, 'sneaked-in.txt'), 'extra\n')
  const report = verifyCandidate(syntheticCandidate, verifyReports)
  if (!report.failed.includes('manifest-covers-all-files'))
    throw new Error('清单外的文件未被完整性检查发现')
  rmSync(join(syntheticCandidate, 'sneaked-in.txt'))
  return 'manifest-covers-all-files 失败'
})
expectOk('verify: stubbed-artifact-refused', () => {
  const manifestPath = join(syntheticCandidate, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.toolchainStubbed = true
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  const report = verifyCandidate(syntheticCandidate, verifyReports)
  manifest.toolchainStubbed = false
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  if (!report.failed.includes('toolchain-not-stubbed')) throw new Error('替身产物未被拒绝')
  return 'toolchain-not-stubbed 失败'
})

// 15. 官方归档：真实解包、真实 apply、真实入口编排。
if (values['source-archive']) {
  const archive = resolve(values['source-archive'])
  const officialSource = join(scratch('official source'), 'src')
  expectOk('official-archive: digest', () => {
    const actual = sha256File(archive)
    if (actual !== plan.official.archiveSha256) throw new Error(`归档摘要不符：${actual}`)
    return actual
  })
  expectOk(
    'official-archive: extract',
    () => `${extractOfficialSource(archive, officialSource, null)} 个条目`,
  )
  expectOk('official-archive: apply-patches', () =>
    applyPatches(officialSource, null)
      .map((patch) => patch.id)
      .join(','),
  )
  expectOk('official-archive: gates-artifacts', () => {
    if (
      !existsSync(
        join(officialSource, 'packages/local-runtime/test/unit/local-bash-shell-path.test.ts'),
      )
    )
      throw new Error('回归测试文件缺失')
    if (
      !readFileSync(join(officialSource, 'test/vitest-suites.json'), 'utf8').includes(
        'local-bash-shell-path.test.ts',
      )
    )
      throw new Error('Vitest 组未登记该测试')
    if (
      !readFileSync(join(officialSource, 'release/public-source.json'), 'utf8').includes(
        'local-bash-shell-path.test.ts',
      )
    )
      throw new Error('公开清单未登记该文件')
    if (
      !readFileSync(
        join(officialSource, 'third_party/pi-mono/MINIMAX_CHANGES.md'),
        'utf8',
      ).includes('process-local shell selection')
    )
      throw new Error('vendored 修改台账未记录')
    return '测试、Vitest 组、公开清单与 vendored 台账均已更新'
  })
  expectThrow('official-archive: refuse-dirty-target', '解包目标非空', () =>
    extractOfficialSource(archive, officialSource, null),
  )

  // 入口守卫必须在创建输出目录之前生效。
  const guardedOut = join(scratch('guard'), 'build output')
  expectOk('entry: build-rejects-missing-runtime-source', () => {
    const run = runEntry('build-candidate.mjs', [
      '--out',
      guardedOut,
      '--source-archive',
      archive,
      '--offline',
    ])
    if (run.code === 0) throw new Error('缺少运行时来源却通过了')
    if (existsSync(guardedOut)) throw new Error('被拒绝的调用仍创建了输出目录')
    if (!`${run.stderr}${run.stdout}`.includes('--system-node'))
      throw new Error(
        `未给出运行时来源指引：${`${run.stderr}${run.stdout}`.trim().split('\n').slice(-3).join(' | ')}`,
      )
    return '拒绝且未创建输出目录'
  })

  // 真实编排：构建入口（替身工具链）→ 组装 → 验证入口。
  const orchestrated = join(scratch('orchestration'), 'build output')
  const shim = join(scriptDir, 'fixtures', 'toolchain-shim.mjs')
  expectOk('entry: build-assembles-with-shim', () => {
    const run = runEntry('build-candidate.mjs', [
      '--out',
      orchestrated,
      '--system-node',
      '--source-archive',
      archive,
      '--execute',
      '--toolchain-shim',
      shim,
    ])
    if (run.code !== 0)
      throw new Error(
        `入口退出码 ${run.code}：${`${run.stderr}${run.stdout}`.trim().split('\n').slice(-4).join(' | ')}`,
      )
    const candidateDir = join(orchestrated, plan.candidateVersion)
    if (!existsSync(join(candidateDir, 'cli.js'))) throw new Error('未组装出候选目录')
    const log = JSON.parse(
      readFileSync(join(orchestrated, 'work', 'src', '.toolchain-stub.json'), 'utf8'),
    )
    const phases = log.calls.map((call) => call.phase)
    for (const phase of ['install', 'bundle', 'gate'])
      if (!phases.includes(phase)) throw new Error(`替身未收到 ${phase} 阶段：${phases.join(',')}`)
    const install = log.calls.find((call) => call.phase === 'install')
    if (!Array.isArray(install.argv) || install.argv[0] !== 'pnpm')
      throw new Error(`install argv 形状不对：${JSON.stringify(install.argv)}`)
    const outDirArg = log.calls.find((call) => call.cwd.includes(' '))
    void outDirArg
    return `阶段 ${phases.length} 次；install argv=${JSON.stringify(install.argv)}`
  })
  expectOk('entry: build-reports-unresolved-modules', () => {
    const manifest = JSON.parse(readFileSync(join(orchestrated, 'candidate-manifest.json'), 'utf8'))
    if (!manifest.externalModules?.unresolved?.length)
      throw new Error('未如实报告未解析的外部模块依赖')
    return manifest.externalModules.unresolved.slice(0, 2).join(' ')
  })
  expectOk('entry: verify-refuses-stubbed-candidate', () => {
    const candidateDir = join(orchestrated, plan.candidateVersion)
    const reportDir = join(orchestrated, 'verification')
    const run = runEntry('verify-candidate.mjs', [
      '--candidate',
      candidateDir,
      '--manifest',
      join(orchestrated, 'candidate-manifest.json'),
      '--out',
      reportDir,
      '--skip-smoke',
    ])
    if (run.code === 0) throw new Error('替身产物被当作可分发产物通过')
    const report = JSON.parse(readFileSync(join(reportDir, 'candidate-verification.json'), 'utf8'))
    if (!report.failed.includes('toolchain-not-stubbed'))
      throw new Error(`失败项不对：${report.failed}`)
    if (report.boundaries.distributable !== false) throw new Error('报告未声明不可分发')
    return `失败项：${report.failed.join(', ')}`
  })
  expectOk('entry: licenses-landed-in-candidate', () => {
    const candidateDir = join(orchestrated, plan.candidateVersion)
    const missing = licenseTargets().filter((file) => !existsSync(join(candidateDir, file)))
    if (missing.length) throw new Error(`候选目录缺少许可文件：${missing.join(', ')}`)
    return `${licenseTargets().length} 份许可文件就位`
  })
} else {
  record(
    'official-archive: apply-patches',
    false,
    '未提供 --source-archive，跳过真实应用',
    'skipped',
  )
  record(
    'entry: build-assembles-with-shim',
    false,
    '未提供 --source-archive，跳过入口编排',
    'skipped',
  )
}

// 15. 执行闸门负控：只放一个会写 marker 的启动器，其他先验全缺 —— 必须零执行。
const negativeRoot = scratch('negative control')
const negativeCandidate = join(negativeRoot, 'candidate')
write(
  join(negativeCandidate, plan.launcher.windows),
  [
    '@ECHO off',
    'echo EXECUTED >> "%~dp0marker.txt"',
    'echo SYNTHETIC_VERSION',
    'EXIT /B 0',
    '',
  ].join('\r\n'),
)
expectOk('gate: no-execution-when-prior-checks-fail', () => {
  const reportDir = mkdirp(join(negativeRoot, 'report'))
  const report = verifyCandidate(negativeCandidate, reportDir)
  if (existsSync(join(negativeCandidate, 'marker.txt')))
    throw new Error('候选代码被执行了（marker 已写入）')
  if (report.executionGate.candidateCodeExecuted) throw new Error('报告声称执行了候选代码')
  if (!report.isolatedEntrySmoke.skipped) throw new Error('未记录跳过的原因')
  if (!report.executionGate.skippedReason?.includes('先验检查失败'))
    throw new Error(`跳过原因不对：${report.executionGate.skippedReason}`)
  if (report.failed.length < 5) throw new Error('先验失败项过少，负控没有覆盖到')
  return `先验失败 ${report.failed.length} 项，零执行，跳过原因已记录`
})
expectOk('gate: cli-entry-rejects-同样零执行', () => {
  const reportDir = join(negativeRoot, 'report cli')
  const run = runEntry('verify-candidate.mjs', [
    '--candidate',
    negativeCandidate,
    '--out',
    reportDir,
  ])
  if (run.code === 0) throw new Error('公开入口居然通过了')
  if (existsSync(join(negativeCandidate, 'marker.txt'))) throw new Error('公开入口执行了候选代码')
  if (!run.stdout.includes('未执行')) throw new Error(`未打印执行闸门状态：${run.stdout}`)
  return `退出码 ${run.code}，marker 未写入`
})

// 16. 报告目录与 smoke 数据目录：被拒绝时不能留下目录。
expectOk('report-dir: forbidden-target-not-created', () => {
  const profile = mkdirp(join(scratch('forbidden'), 'synthetic-home', '.dsh'))
  const previous = process.env.OPL_DSH_HOME
  process.env.OPL_DSH_HOME = profile
  try {
    const forbidden = join(profile, 'forbidden-report')
    expectThrow('report-dir: forbidden-target-inner', '重叠', () =>
      verifyCandidate(negativeCandidate, forbidden),
    )
    if (existsSync(forbidden)) throw new Error('被拒绝的报告目录仍被创建')
  } finally {
    if (previous === undefined) delete process.env.OPL_DSH_HOME
    else process.env.OPL_DSH_HOME = previous
  }
  return '拒绝后未创建任何目录'
})

// 17. 离线入口：全新输出目录、无网络、坏摘要在写缓存前被拒。
if (values['source-archive'] && values['tools-archive']) {
  expectOk('offline: fresh-preflight-without-network', () => {
    const out = join(scratch('offline'), 'fresh output')
    const run = runEntry('build-candidate.mjs', [
      '--out',
      out,
      '--system-node',
      '--offline',
      '--source-archive',
      resolve(values['source-archive']),
      '--tools-archive',
      resolve(values['tools-archive']),
    ])
    if (run.code !== 0)
      throw new Error(
        `退出码 ${run.code}：${`${run.stderr}${run.stdout}`.trim().split('\n').slice(-2).join(' | ')}`,
      )
    const trace = readFileSync(join(out, 'build-trace.jsonl'), 'utf8')
    if (trace.includes('"event":"download"')) throw new Error('离线模式仍发生了下载')
    if (!existsSync(join(out, 'work/src/.cache/artifacts/code-0.3.11.tgz')))
      throw new Error('未写入官方构建读取的缓存位置')
    return '全新目录离线预检通过，无下载事件'
  })
  expectOk('offline: requires-tools-archive', () => {
    const out = join(scratch('offline'), 'missing tools')
    const run = runEntry('build-candidate.mjs', [
      '--out',
      out,
      '--system-node',
      '--offline',
      '--source-archive',
      resolve(values['source-archive']),
    ])
    if (run.code === 0) throw new Error('缺少 --tools-archive 却通过了')
    if (!`${run.stderr}${run.stdout}`.includes('--tools-archive'))
      throw new Error('未提示需要 --tools-archive')
    return '拒绝并给出明确指引'
  })
  expectOk('offline: bad-tools-digest-refused-before-cache', () => {
    const out = join(scratch('offline'), 'bad digest')
    const badArchive = join(out, '..', 'bad-tools.tgz')
    write(badArchive, 'not-a-real-tarball')
    const run = runEntry('build-candidate.mjs', [
      '--out',
      out,
      '--system-node',
      '--offline',
      '--source-archive',
      resolve(values['source-archive']),
      '--tools-archive',
      badArchive,
    ])
    if (run.code === 0) throw new Error('坏摘要却通过了')
    if (existsSync(join(out, 'work/src/.cache/artifacts/code-0.3.11.tgz')))
      throw new Error('坏摘要仍写入了官方缓存')
    return '摘要不符且缓存未写入'
  })
}

// 18. 外部模块闭包必须解析在候选目录内，不能落到构建树或仓库 node_modules。
expectOk('modules: closure-escape-detected', () => {
  const tree = scratch('closure escape')
  const moduleDir = mkdirp(join(tree, 'src', 'node_modules', 'fake-mod'))
  write(
    join(moduleDir, 'package.json'),
    `${JSON.stringify({ name: 'fake-mod', version: '1.0.0' })}\n`,
  )
  write(join(moduleDir, 'index.js'), '// fake\n')
  const candidateDir = mkdirp(join(tree, 'candidate'))
  mkdirp(join(candidateDir, 'node_modules'))
  symlinkSync(moduleDir, join(candidateDir, 'node_modules', 'fake-mod'), 'junction')
  const report = verifyExternalModuleClosure(candidateDir, ['fake-mod'])
  if (report.ok || report.escaped.length !== 1 || report.missing.length)
    throw new Error('已解析的逃逸包未被识别')
  return '解析到候选目录外的真实包被拒绝'
})

const nestedTree = scratch('nested dependencies')
const moduleManifest = (directory, value) =>
  write(join(directory, 'package.json'), JSON.stringify(value) + '\n')
const nestedA = join(nestedTree, 'node_modules', 'a')
const nestedB = join(nestedA, 'node_modules', 'b')
moduleManifest(nestedA, { name: 'a', version: '1', dependencies: { b: '2' } })
moduleManifest(nestedB, { name: 'b', version: '2', dependencies: { absent: '1' } })
moduleManifest(join(nestedTree, 'node_modules', 'b'), { name: 'b', version: '1' })
expectOk('modules: nested-importer-dependency-missing', () => {
  const report = verifyExternalModuleClosure(nestedTree, ['a'])
  if (report.ok || !report.missing.includes('absent'))
    throw new Error('根目录同名包掩盖了嵌套依赖缺失')
  return '按实际依赖方解析，缺失嵌套依赖被拒绝'
})
expectOk('modules: colliding-versions-retain-importer-selection', () => {
  const candidate = join(scratch('copy collision'), 'candidate')
  const result = copyExternalModules(nestedTree, candidate, ['a', 'b'])
  const rootB = JSON.parse(readFileSync(join(candidate, 'node_modules/b/package.json'), 'utf8'))
  const privateB = JSON.parse(
    readFileSync(join(candidate, 'node_modules/a/node_modules/b/package.json'), 'utf8'),
  )
  if (rootB.version !== '1' || privateB.version !== '2') throw new Error('同名依赖版本被覆盖')
  if (!result.copied.includes('a') || !result.copied.includes('b'))
    throw new Error('根依赖未登记到 copied 包名清单')
  if (!result.unresolved.includes('absent')) throw new Error('嵌套缺失依赖未保留')
  return '根包与嵌套包版本分别保留，缺失依赖仍报告'
})
expectOk('modules: scoped-cycles-reuse-ancestor-without-links', () => {
  const tree = scratch('scoped dependency cycle')
  moduleManifest(join(tree, 'node_modules/parent'), {
    name: 'parent',
    version: '1',
    dependencies: { '@demo/leaf': '1' },
  })
  moduleManifest(join(tree, 'node_modules/@demo/leaf'), {
    name: '@demo/leaf',
    version: '1',
    dependencies: { parent: '1' },
  })
  const candidate = join(scratch('copied cycle'), 'candidate')
  const copied = copyExternalModules(tree, candidate, ['parent'])
  const closure = verifyExternalModuleClosure(candidate, ['parent'])
  if (!closure.ok || copied.closureSize !== 2 || closure.resolved !== 2)
    throw new Error('作用域包的循环依赖未在候选目录内闭合')
  return '两个真实目录，无复制递归或构建树链接'
})
expectOk('modules: platform-optional-dependency-may-be-absent', () => {
  const tree = scratch('optional dependency')
  moduleManifest(join(tree, 'node_modules', 'optional-owner'), {
    name: 'optional-owner',
    version: '1',
    optionalDependencies: { 'not-installed-for-platform': '1' },
  })
  const report = verifyExternalModuleClosure(tree, ['optional-owner'])
  if (!report.ok) throw new Error('未安装的可选依赖阻止当前平台验收')
  return '已安装依赖仍检查，未安装可选项允许缺失'
})

await Promise.all(pending)

const passed = results.filter((item) => item.ok).length
const failed = results.filter((item) => !item.ok)
const reportPath = join(base, 'self-test.json')
writeJson(reportPath, { total: results.length, passed, failed: failed.length, results })
for (const item of results)
  console.log(
    `${item.ok ? 'PASS' : item.kind === 'skipped' ? 'SKIP' : 'FAIL'} ${item.name}${item.detail ? ` — ${item.detail}` : ''}`,
  )
console.log(`自检：${passed}/${results.length} 通过，报告 ${reportPath}`)
if (failed.length) process.exit(1)

function basenameOf(path) {
  return path.split(/[\\/]/).pop()
}

/** Windows 环境变量名大小写不敏感：先清掉已有的 Path/PATH，再写入唯一的 PATH。 */
function withPath(...extra) {
  const env = {}
  for (const [key, value] of Object.entries(process.env))
    if (key.toUpperCase() !== 'PATH') env[key] = value
  env.PATH = [...extra, process.env.PATH ?? process.env.Path ?? ''].join(';')
  return env
}
