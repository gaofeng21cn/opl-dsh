/** Immutable, pinned Codex Git Bash packages. Validation never executes package code. */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  codexCandidatePlan as plan,
  importCodexCandidate,
  plainPath,
  verifyCodexCandidate,
} from '../../src/execution/host/candidates/codex/lifecycle.ts'

export { plan as codexCandidatePlan, importCodexCandidate, plainPath, verifyCodexCandidate }

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** Package the exact previously accepted executable with pinned patches and upstream notices. */
export function packageCodexCandidate(binary, output, assets = import.meta.dirname) {
  const target = plainPath(output)
  if (existsSync(target)) throw Error('交付目录已存在，未覆盖')
  if (digest(readFileSync(binary)) !== plan.files['bin/codex.exe'])
    throw Error('二进制与已验收构建不一致')
  mkdirSync(target, { recursive: true, mode: 0o700 })
  for (const file of Object.keys(plan.files)) {
    const source = file.startsWith('patches/')
      ? join(assets, file)
      : file === 'LICENSE' || file === 'NOTICE'
        ? join(assets, 'licenses', file)
        : join(dirname(dirname(binary)), file)
    const bytes =
      file === 'LICENSE' || file === 'NOTICE'
        ? Buffer.from(readFileSync(source, 'utf8').replaceAll('\r\n', '\n'))
        : readFileSync(source)
    if (digest(bytes) !== plan.files[file]) throw Error('交付输入摘要不一致：' + file)
    mkdirSync(dirname(join(target, file)), { recursive: true, mode: 0o700 })
    writeFileSync(join(target, file), bytes, { flag: 'wx' })
  }
  writeFileSync(join(target, 'manifest.json'), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' })
  return verifyCodexCandidate(target)
}
