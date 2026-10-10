/**
 * 有界入口自检用的工具链替身。
 *
 * 官方构建链要求 pnpm 9.12.0 与原生模块安装，本仓库不安装真实依赖、不做完整 bundle。
 * 替身只做两件事：记录收到的每个 argv（验证调用形状与含空格路径没有被重新解释），
 * 并生成最小 dist 布局，让组装与验证阶段可以真实跑通。
 *
 * 替身产物由 `--toolchain-shim` 标记为 stubbed，验证器会拒绝把它当作可分发产物。
 * 用法：node toolchain-shim.mjs <phase> <argv...>
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const [phase, ...argv] = process.argv.slice(2)
if (!phase) throw new Error('用法：node toolchain-shim.mjs <phase> <argv...>')
const root = resolve(process.cwd())
const recordPath = join(root, '.toolchain-stub.json')

const log = readRecord()
log.calls.push({ phase, argv, cwd: root })
writeFileSync(recordPath, `${JSON.stringify(log, null, 2)}\n`, 'utf8')

if (phase !== 'bundle') process.exit(0)

// 最小 dist 布局：覆盖组装阶段会复制的每个条目，并带上能力标记。
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const dist = join(root, 'dist')
const write = (relative, text) => {
  const target = join(dist, relative)
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, text)
}
write('cli.js', '// stub cli\n')
write('package.json', `${JSON.stringify({ name: '@minimax-ai/code', version }, null, 2)}\n`)
write('image-preview-worker.js', '// stub worker\n')
write('mcode-tools.js', '// stub mcode tools\n')
write('matrix-mcp-stdio.js', '// stub matrix\n')
write('metafile.json', '{}\n')
write('embedded/mcode-tools/cli.mjs', '// stub embedded cli\n')
write('embedded/mcode-tools/manifest.json', `${JSON.stringify({ version: '0.0.4' })}\n`)
write(
  'chunks/main.js',
  'const shell="minimax-code/shell";const env="MCODE_SHELL_PATH";export {shell,env}\n',
)
write('internal-bin/mcode-tools', '#!/bin/sh\n')
write('configs/config.json', '{}\n')
write('native/placeholder.txt', 'stub\n')
write('vendor/srt-win/placeholder.txt', 'stub\n')
write('vendor/seccomp/placeholder.txt', 'stub\n')
write('photon_rs_bg.wasm', 'stub wasm\n')

// 外部模块：官方 bundle 之外的原生依赖。故意声明一个未提供的传递依赖，
// 让组装阶段如实报告 unresolved，而不是假装模块可运行。
for (const name of [
  'better-sqlite3',
  '@mariozechner/clipboard',
  '@vscode/ripgrep',
  '@larksuiteoapi/node-sdk',
]) {
  const target = join(root, 'node_modules', ...name.split('/'))
  mkdirSync(target, { recursive: true })
  writeFileSync(
    join(target, 'package.json'),
    `${JSON.stringify(
      {
        name,
        version: '0.0.0-stub',
        main: 'index.js',
        dependencies: { 'stub-only-missing-dep': '1.0.0' },
      },
      null,
      2,
    )}\n`,
  )
  writeFileSync(join(target, 'index.js'), '// stub module\n')
}
process.exit(0)

function readRecord() {
  try {
    return JSON.parse(readFileSync(recordPath, 'utf8'))
  } catch {
    return { calls: [] }
  }
}
