import { join } from 'node:path'
import {
  assertStoreRoot,
  defaultStoreRoot,
  importCandidate,
  verifyImportCandidate,
  versionDir,
} from '../../../scripts/mcode-candidate/lifecycle.mjs'
import type { MiniMaxCandidateRequest } from '../contracts/candidate.ts'

/**
 * Verify a suite-owned candidate before publishing its launch command.
 * @param request Version and optional directory to import without replacement.
 * @returns Verified launcher path and file digests; no candidate code is executed.
 */
export function prepareMiniMaxCandidate(request: MiniMaxCandidateRequest) {
  if (typeof request.version !== 'string') throw Error('候选版本无效')
  const store = assertStoreRoot(defaultStoreRoot())
  const destination = versionDir(store, request.version)
  if (request.source !== undefined) {
    if (typeof request.source !== 'string' || !request.source.trim()) throw Error('候选来源无效')
    const imported = importCandidate({
      source: request.source,
      store,
      version: request.version,
      activeTasks: 0,
    })
    if (!imported.ok) throw Error(`候选导入校验失败：${imported.failed?.join('、') ?? '未通过'}`)
  }
  const verified = verifyImportCandidate(destination, {
    version: request.version,
    manifestPath: join(destination, 'manifest.json'),
  })
  if (
    !verified.passed ||
    !verified.launcherPath ||
    !verified.manifestSha256 ||
    !verified.launcherSha256
  )
    throw Error(`候选选择校验失败：${verified.failed.join('、')}`)
  return {
    command: verified.launcherPath,
    manifestSha256: verified.manifestSha256,
    launcherSha256: verified.launcherSha256,
  }
}
