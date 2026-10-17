/** Resolve only the package manager shipped with the selected official Desktop. */
const { existsSync } = require('node:fs')
const { join } = require('node:path')

function officialPnpm(resources) {
  for (const path of [
    'runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs',
    'runtime/pnpm/bin/pnpm.mjs',
    'runtime/pnpm/bin/pnpm.cjs',
  ]) {
    const entry = join(resources, path)
    if (existsSync(entry)) return entry
  }
  throw new Error('官方桌面缺少内置 pnpm 入口，已停止插件安装。')
}

module.exports = { officialPnpm }
