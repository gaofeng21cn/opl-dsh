import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
const zip = join(import.meta.dirname, 'dist/OPL-DSH-Setup-0.1.0-mac-arm64.zip')
rmSync(zip, { force: true })
execFileSync('ditto', ['-c', '-k', '--keepParent', join(import.meta.dirname, 'dist/OPL DSH 一键安装'), zip])
console.log(zip)
