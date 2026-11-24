import { execFileSync } from 'node:child_process'
/** Plan-bound DSH cleanup. It only recycles an exact, offline-verified target set. */
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  lstatSync,
  statSync,
  readdirSync,
  openSync,
  closeSync,
  unlinkSync,
  fsyncSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { homedir, tmpdir } from 'node:os'
import { parseArgs } from 'node:util'
import lockfile from 'proper-lockfile'
import writeFileAtomic from 'write-file-atomic'
import { loadDshSnapshot } from './snapshot.mjs'
import * as windows from './windows-io.mjs'
import {
  acquireMacSessionLocks,
  assertDesktopStopped as macDesktopStopped,
  currentMacTrash,
} from './macos-io.mjs'
const { safeTree, assertSafePath } = windows
const assertDesktopStopped =
  process.platform === 'darwin' ? macDesktopStopped : windows.assertDesktopStopped
const recycleIO = () => (process.platform === 'darwin' ? currentMacTrash() : windows)

const digest = (value) => createHash('sha256').update(value).digest('hex')
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value
const validId = (value) =>
  typeof value === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value) &&
  !value.includes('..')

export function hashPlan(plan) {
  const { planHash, createdAt, stats, ...body } = plan
  return digest(JSON.stringify(canonical(body)))
}
function validateSelector(selector) {
  if (!selector || !['ids', 'archived', 'workspaces'].includes(selector.kind))
    throw Error('范围必须为 ids、archived 或 workspaces')
  const fields =
    selector.kind === 'ids'
      ? ['kind', 'sessionIds', 'externalIds', 'excludeSessionIds']
      : selector.kind === 'archived'
        ? ['kind', 'excludeSessionIds']
        : ['kind', 'workspaceIds', 'excludeSessionIds']
  fields.push('pruneEmptyWorkspaces')
  if (
    selector.pruneEmptyWorkspaces !== undefined &&
    typeof selector.pruneEmptyWorkspaces !== 'boolean'
  )
    throw Error('工作区清理选项无效')
  if (Object.keys(selector).some((key) => !fields.includes(key))) throw Error('未知范围字段')
  for (const key of fields.filter((key) => key !== 'kind' && key !== 'pruneEmptyWorkspaces'))
    if (
      selector[key] !== undefined &&
      (!Array.isArray(selector[key]) || !selector[key].every(validId))
    )
      throw Error('范围 ID 无效')
  if (selector.kind === 'ids' && !selector.sessionIds?.length && !selector.externalIds?.length)
    throw Error('精确范围不能为空')
  if (selector.kind === 'workspaces' && !selector.workspaceIds?.length)
    throw Error('工作区范围不能为空')
  return canonical(structuredClone(selector))
}
function prepareIndices(indices, ids, prune = false) {
  return indices.map((index) => {
    const before = Buffer.from(index.bytes, 'base64')
    if (digest(before) !== index.sha256) throw Error('索引快照校验失败')
    let after = before
    const normalized = index.path.replaceAll('\\', '/')
    if (normalized.endsWith('session_index.jsonl'))
      after = Buffer.from(
        before
          .toString('utf8')
          .split(/(?<=\n)/)
          .filter((line) => !line.trim() || !ids.has(JSON.parse(line).sessionId))
          .join(''),
      )
    else {
      const state = JSON.parse(before.toString('utf8'))
      const original = JSON.stringify(state)
      if (normalized.endsWith('storages/workspace.json')) {
        for (const [id, workspace] of Object.entries(state.tables?.workspaces ?? {}))
          if (Array.isArray(workspace.sessionIds)) {
            const touched = workspace.sessionIds.some((sessionId) => ids.has(sessionId))
            workspace.sessionIds = workspace.sessionIds.filter((sessionId) => !ids.has(sessionId))
            if (prune && touched && workspace.sessionIds.length === 0) {
              delete state.tables.workspaces[id]
              if (Array.isArray(state.global?.workspaceIds))
                state.global.workspaceIds = state.global.workspaceIds.filter(
                  (workspaceId) => workspaceId !== id,
                )
            }
          }
        for (const key of ['archivedSessionIds', 'pinnedSessionIds'])
          if (Array.isArray(state.global?.[key]))
            state.global[key] = state.global[key].filter((id) => !ids.has(id))
      } else if (normalized.endsWith('combination-selection.json'))
        for (const id of ids) delete state[id]
      else if (normalized.endsWith('external-effort-selection.json'))
        for (const key of Object.keys(state)) {
          const parts = JSON.parse(key)
          if (Array.isArray(parts) && ids.has(parts[0])) delete state[key]
        }
      if (JSON.stringify(state) !== original)
        after = Buffer.from(JSON.stringify(state, null, 2) + '\n')
    }
    return { ...index, after: after.toString('base64'), afterSha256: digest(after) }
  })
}
function validatePath(path, root) {
  const base = resolve(root)
  const target = resolve(path)
  const rel = relative(base, target)
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))
    throw Error('路径超出允许范围')
  if (existsSync(base) && lstatSync(base).isSymbolicLink()) throw Error('禁止重解析数据根')
  let current = base
  for (const part of rel.split(sep)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw Error('禁止重解析路径')
    current = join(current, part)
  }
  if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw Error('禁止重解析路径')
}
function validateTargetPath(target, home) {
  const root =
    target.kind === 'session'
      ? join(home, 'sessions')
      : join(home, 'profiles', 'desktop', 'harness-sessions')
  validatePath(target.path, root)
}
/** Select exact identities, including native owners of selected Harness records. */
export function buildCleanupPlan(input) {
  const selector = validateSelector(input.selector)
  const sessions = input.sessions
  const external = input.externalRecords ?? []
  if (!Array.isArray(sessions)) throw Error('Session 快照缺失')
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const byExternal = new Map(external.map((record) => [record.id, record]))
  if (byId.size !== sessions.length || [...byId.keys()].some((id) => !validId(id)))
    throw Error('Session ID 无效或重复')
  if (byExternal.size !== external.length || [...byExternal.keys()].some((id) => !validId(id)))
    throw Error('Harness ID 无效或重复')
  const requested = new Set()
  const skipped = []
  if (selector.kind === 'archived')
    for (const id of input.workspace?.archivedSessionIds ?? []) requested.add(id)
  if (selector.kind === 'ids') {
    for (const id of selector.sessionIds ?? []) requested.add(id)
    for (const id of selector.externalIds ?? []) {
      const record = byExternal.get(id)
      if (!record || !byId.has(record.nativeSessionId))
        skipped.push({ kind: 'external', id, reason: 'unknown-native-owner' })
      else requested.add(record.nativeSessionId)
    }
  }
  if (selector.kind === 'workspaces')
    for (const id of selector.workspaceIds) {
      const workspace = input.workspace?.workspaces?.[id]
      if (!workspace) throw Error('工作区不存在: ' + id)
      for (const sessionId of workspace.sessionIds ?? []) requested.add(sessionId)
    }
  for (const id of selector.excludeSessionIds ?? []) requested.delete(id)
  const reason = (value) =>
    !value
      ? 'session-not-found'
      : value.active === true
        ? 'session-active'
        : value.active !== false
          ? 'activity-unknown'
          : value.blockers?.length
            ? 'unresolved-reference'
            : value.active === undefined
              ? 'activity-unknown'
              : null
  const accepted = new Set()
  for (const id of [...requested].sort()) {
    const session = byId.get(id)
    let blocked = reason(session)
    for (const record of external.filter((item) => item.nativeSessionId === id))
      blocked ??= reason(record)
    if (blocked) skipped.push({ kind: 'session', id, reason: blocked })
    else accepted.add(id)
  }
  let changed = true
  while (changed) {
    changed = false
    for (const id of [...accepted]) {
      const refs = [
        ...(byId.get(id).lineageRefs ?? []),
        ...external
          .filter((item) => item.nativeSessionId === id)
          .flatMap((item) => item.lineageRefs ?? []),
      ]
      if (refs.some((ref) => !accepted.has(ref))) {
        accepted.delete(id)
        skipped.push({ kind: 'session', id, reason: 'retained-lineage-reference' })
        changed = true
      }
    }
  }
  const targets = []
  for (const id of [...accepted].sort()) {
    const session = byId.get(id)
    targets.push({ kind: 'session', id, path: session.path, tree: session.tree })
    for (const record of external
      .filter((item) => item.nativeSessionId === id)
      .sort((a, b) => a.id.localeCompare(b.id)))
      targets.push({
        kind: 'external',
        id: record.id,
        nativeSessionId: id,
        path: record.path,
        tree: record.tree,
      })
  }
  const plan = {
    version: 2,
    home: input.home,
    selector,
    sessions: sessions.map((row) => ({
      id: row.id,
      title: row.title ?? null,
      archived: input.workspace?.archivedSessionIds?.includes(row.id) ?? false,
      workspace:
        Object.entries(input.workspace?.workspaces ?? {}).find(([, w]) =>
          w.sessionIds?.includes(row.id),
        )?.[0] ?? null,
    })),
    targetSessionIds: [...accepted].sort(),
    protectedSessionIds: sessions
      .filter((session) => !accepted.has(session.id))
      .map((session) => session.id)
      .sort(),
    targets,
    skipped,
    blockers: input.blockers ?? [],
    inventory: [...sessions, ...external]
      .flatMap((item) => item.files ?? [])
      .sort((a, b) => a.path.localeCompare(b.path)),
    indices: prepareIndices(input.indices ?? [], accepted, selector.pruneEmptyWorkspaces),
    createdAt: new Date().toISOString(),
    stats: input.stats ?? {},
  }
  const sqlite = [...accepted]
    .sort()
    .map((id) => byId.get(id).sqlite)
    .filter(Boolean)
  if (sqlite.length) {
    plan.sqlite = sqlite
    plan.sqliteProtected = sessions
      .filter((s) => s.sqlite && !accepted.has(s.id))
      .map((s) => ({
        id: s.id,
        history: s.sqlite.history,
        header: digest(s.sqlite.row.header),
      }))
  }
  return { ...plan, planHash: hashPlan(plan) }
}
function assertPlan(plan, expectedHash) {
  if (
    plan.version !== 2 ||
    !expectedHash ||
    expectedHash !== plan.planHash ||
    hashPlan(plan) !== expectedHash
  )
    throw Error('清理计划已变化，请重新预览')
  if (plan.blockers.length) throw Error('存在未解析存储或引用，已停止')
  if (!isAbsolute(plan.home)) throw Error('数据根无效')
  for (const target of plan.targets) {
    validateTargetPath(target, plan.home)
    if (!target.tree) throw Error('目标缺少文件指纹')
  }
  for (const index of plan.indices) {
    validatePath(index.path, plan.home)
    if (
      digest(Buffer.from(index.bytes, 'base64')) !== index.sha256 ||
      digest(Buffer.from(index.after, 'base64')) !== index.afterSha256
    )
      throw Error('索引摘要不一致')
  }
}
function atomicWrite(path, bytes) {
  writeFileAtomic.sync(path, bytes, { mode: 0o600 })
}
function captureReferenceDirectories(home) {
  return [
    join(home, 'storages'),
    join(home, 'profiles', 'desktop'),
    join(home, 'profiles', 'desktop', 'harness-sessions'),
  ].map((path) => ({
    path,
    entries: existsSync(path)
      ? readdirSync(path, { withFileTypes: true })
          .map((entry) => entry.name)
          .sort()
      : [],
  }))
}
function attachReferenceDirectories(plan) {
  plan.referenceDirectories = captureReferenceDirectories(plan.home)
  plan.planHash = hashPlan(plan)
  return plan
}
const save = (path, value) => atomicWrite(path, JSON.stringify(value, null, 2) + '\n')
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
const targetKey = (target) => target.kind + ':' + target.id
/** Preview reads real storage while the specified Desktop is stopped. */
export async function previewCleanup({ home, selector, planFile, executable, title }) {
  const started = performance.now()
  if (!home || !executable) throw Error('必须指定数据根和 Desktop 可执行文件')
  home = resolve(home)
  executable = resolve(executable)
  await assertDesktopStopped(executable, home)
  const snapshot = await loadDshSnapshot({ home, selector, title })
  selector = snapshot.selector
  await assertDesktopStopped(executable, home)
  const plan = buildCleanupPlan({ ...snapshot, home, selector })
  if (process.platform === 'darwin') acquireMacSessionLocks(plan.targets)()
  plan.executable = executable
  attachReferenceDirectories(plan)
  if (planFile) {
    mkdirSync(dirname(resolve(planFile)), { recursive: true })
    writeFileSync(resolve(planFile), JSON.stringify(plan, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    })
  }
  return { ...plan, stats: { ...plan.stats, previewMs: Math.round(performance.now() - started) } }
}
function checkIndices(plan, allowAfter) {
  for (const index of plan.indices) {
    const actual = digest(readFileSync(index.path))
    if (actual !== index.sha256 && !(allowAfter && actual === index.afterSha256))
      throw Error('索引已变化: ' + index.path)
  }
}
function checkInventoryFast(plan, completed) {
  for (const directory of plan.referenceDirectories ?? []) {
    const actual = existsSync(directory.path)
      ? readdirSync(directory.path, { withFileTypes: true })
          .map((entry) => entry.name)
          .sort()
      : []
    const expected = new Set(directory.entries)
    for (const entry of [...expected]) {
      if (
        plan.targets.some(
          (target) =>
            completed.includes(targetKey(target)) &&
            resolve(target.path) === resolve(join(directory.path, entry)),
        )
      )
        expected.delete(entry)
    }
    if (JSON.stringify(actual) !== JSON.stringify([...expected].sort()))
      throw Error('引用索引集合已变化')
  }
  const deleted = plan.targets.filter((target) => completed.includes(targetKey(target)))
  const isDeleted = (path) =>
    deleted.some((target) => path === target.path || path.startsWith(target.path + sep))
  for (const file of plan.inventory) {
    const expectedDeleted = isDeleted(file.path)
    try {
      const current = statSync(file.path, { bigint: true })
      if (expectedDeleted) throw Error('已回收目标仍存在: ' + file.path)
      if (Number(current.size) !== file.size || current.mtimeNs.toString() !== file.mtimeNs)
        throw Error('文件清单已变化，请重新核对: ' + file.path)
    } catch (error) {
      if (error?.code === 'ENOENT' && expectedDeleted) continue
      throw error
    }
  }
}

function acquireLock(path, planHash, resume) {
  const dir = dirname(path)
  let releaseGate
  try {
    releaseGate = lockfile.lockSync(join(dir, 'operation-gate'), {
      lockfilePath: join(dir, 'operation-gate.lock'),
      realpath: false,
      stale: 30_000,
    })
  } catch (error) {
    if (error?.code === 'ELOCKED') throw Error('存在其他清理操作')
    throw error
  }
  try {
    if (existsSync(path)) {
      const previous = JSON.parse(readFileSync(path, 'utf8'))
      if (!resume || previous.planHash !== planHash || !Number.isSafeInteger(previous.pid))
        throw Error('存在其他清理操作')
      try {
        process.kill(previous.pid, 0)
        throw Error('清理操作仍在运行')
      } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
      unlinkSync(path)
    }
    const fd = openSync(path, 'wx', 0o600)
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, planHash }))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } finally {
    releaseGate()
  }
}
async function acquirePlanSessionLocks(plan) {
  if (plan.sqlite?.length) {
    const { sqliteLockTargets, acquireSqliteWindowsLocks } = await import('./sqlite-store.mjs')
    const targets = sqliteLockTargets(plan)
    if (process.platform === 'win32') return acquireSqliteWindowsLocks(targets)
    if (process.platform === 'darwin') return acquireMacSessionLocks(targets)
  } else if (process.platform === 'darwin') return acquireMacSessionLocks(plan.targets)
}
/** Recycle exact targets, persist every intent/receipt, then CAS the indices. */
export async function executeDshCleanup({ plan, expectedHash, mode = 'recycle', resume = false }) {
  assertPlan(plan, expectedHash)
  if (mode !== 'recycle') throw Error('没有可用的永久删除协议')
  if (!isAbsolute(plan.executable ?? '')) throw Error('Desktop 可执行文件缺失')
  await assertDesktopStopped(plan.executable, plan.home)
  for (const target of plan.targets)
    if (existsSync(target.path)) await assertSafePath(target.path, plan.home)
  const io = recycleIO()
  if (process.platform === 'darwin')
    for (const target of plan.targets) if (existsSync(target.path)) io.preflight(target.path)
  const history = join(plan.home, 'cleanup-history')
  mkdirSync(history, { recursive: true, mode: 0o700 })
  await assertSafePath(history, plan.home)
  const journal = join(history, plan.planHash + '.json')
  const lock = join(history, 'operation.lock')
  acquireLock(lock, plan.planHash, resume)
  const started = performance.now()
  const timings = {}
  let checkpoint = started
  const mark = (key) => {
    const now = performance.now()
    timings[key] = Math.round(now - checkpoint)
    checkpoint = now
  }
  let releaseSessionLocks
  try {
    releaseSessionLocks = await acquirePlanSessionLocks(plan)
    let state
    if (existsSync(journal)) {
      if (!resume) throw Error('已有执行记录，请使用 resume')
      state = JSON.parse(readFileSync(journal, 'utf8'))
      if (state.planHash !== plan.planHash || !equal(state.plan, plan))
        throw Error('清理记录与计划不一致')
    } else {
      if (resume) throw Error('没有可恢复的清理记录')
      const snapshot = await loadDshSnapshot({ home: plan.home, selector: plan.selector })
      const fresh = buildCleanupPlan({ ...snapshot, selector: plan.selector })
      fresh.executable = plan.executable
      attachReferenceDirectories(fresh)
      if (hashPlan(fresh) !== plan.planHash) throw Error('快照已变化，请重新预览')
      state = { planHash: plan.planHash, plan, items: {}, indicesCommitted: false }
      save(journal, state)
    }
    if (state.restoring || state.restored) throw Error('会话已进入恢复流程')
    if (plan.sqlite) (await import('./sqlite-store.mjs')).sqliteOperation(plan, 'check-recycle')
    mark('prepareMs')
    // Recover a receipt if the process stopped after the recycle call.
    for (const target of plan.targets) {
      const item = state.items[targetKey(target)]
      if (item && !existsSync(target.path)) {
        item.receipt ??= await io.findRecycledTarget(target, item.sinceMs, item.operationId)
        await io.verifyRecycledTarget(target, item.receipt, item.operationId)
        item.completed = true
        save(journal, state)
      }
    }
    const completed = Object.entries(state.items)
      .filter(([, item]) => item.completed)
      .map(([key]) => key)
    checkIndices(plan, completed.length === plan.targets.length)
    checkInventoryFast(plan, completed)
    for (const target of plan.targets) {
      const key = targetKey(target)
      if (state.items[key]?.completed) {
        await io.verifyRecycledTarget(
          target,
          state.items[key].receipt,
          state.items[key].operationId,
        )
        continue
      }
      checkIndices(plan, false)
      if (!equal(await safeTree(target.path), target.tree))
        throw Error('目标内容已变化: ' + target.id)
      state.items[key] = { sinceMs: Date.now(), operationId: randomUUID() }
      save(journal, state)
      state.items[key].receipt = await io.recycleTarget(target, state.items[key].operationId)
      // recycleTarget returns only after validating the original path and recycled tree.
      state.items[key].completed = true
      save(journal, state)
    }
    mark('recycleMs')
    checkInventoryFast(plan, plan.targets.map(targetKey))
    checkIndices(plan, true)
    await assertDesktopStopped(plan.executable, plan.home)
    for (const index of plan.indices) {
      await assertSafePath(index.path, plan.home)
      const actual = digest(readFileSync(index.path))
      if (actual === index.afterSha256) continue
      if (actual !== index.sha256) throw Error('索引已变化: ' + index.path)
      atomicWrite(index.path, Buffer.from(index.after, 'base64'))
    }
    if (plan.sqlite) (await import('./sqlite-store.mjs')).sqliteOperation(plan, 'recycle')
    state.indicesCommitted = true
    save(journal, state)
    mark('indexMs')
    const report = await verifyCleanup({ plan, expectedHash, skipProcessCheck: true })
    mark('verifyMs')
    return { ...report, journal, timings, elapsedMs: Math.round(performance.now() - started) }
  } finally {
    await releaseSessionLocks?.()
    unlinkSync(lock)
  }
}
/** Verify both recycled data and committed indices without starting Desktop. */
export async function verifyCleanup({ plan, expectedHash, skipProcessCheck = false }) {
  assertPlan(plan, expectedHash)
  if (!skipProcessCheck) await assertDesktopStopped(plan.executable, plan.home)
  const state = JSON.parse(
    readFileSync(join(plan.home, 'cleanup-history', plan.planHash + '.json'), 'utf8'),
  )
  if (
    state.restoring ||
    state.restored ||
    !state.indicesCommitted ||
    state.planHash !== plan.planHash
  )
    throw Error('清理尚未完成，请使用 resume')
  for (const target of plan.targets) {
    if (existsSync(target.path)) throw Error('目标仍存在: ' + target.id)
    const item = state.items[targetKey(target)]
    await recycleIO().verifyRecycledTarget(target, item?.receipt, item?.operationId)
  }
  for (const index of plan.indices)
    if (digest(readFileSync(index.path)) !== index.afterSha256) throw Error('索引验收失败')
  checkInventoryFast(plan, plan.targets.map(targetKey))
  if (plan.sqlite) (await import('./sqlite-store.mjs')).sqliteOperation(plan, 'verify')
  return {
    targetCount: plan.targets.length,
    protectedCount: plan.protectedSessionIds.length,
    skipped: plan.skipped,
    verified: true,
  }
}
/** Restore an offline SQLite recycle transaction without overwriting newer index changes. */
export async function restoreCleanup({ plan, expectedHash }) {
  assertPlan(plan, expectedHash)
  if (!plan.sqlite?.length) throw Error('此计划不含 SQLite 会话')
  await assertDesktopStopped(plan.executable, plan.home)
  const history = join(plan.home, 'cleanup-history')
  await assertSafePath(history, plan.home)
  const journal = join(history, plan.planHash + '.json'),
    lock = join(history, 'operation.lock')
  acquireLock(lock, plan.planHash, true)
  let releaseSessionLocks, releaseRestoredLocks
  try {
    const alreadyLocked = new Set(plan.targets.filter((t) => existsSync(t.path)).map((t) => t.path))
    releaseSessionLocks = await acquirePlanSessionLocks(plan)
    const state = JSON.parse(readFileSync(journal, 'utf8'))
    if (!equal(state.plan, plan) || !state.indicesCommitted) throw Error('清理回执不完整')
    const { restoreRecycledTree } = await import('./restore-files.mjs')
    const { sqliteOperation } = await import('./sqlite-store.mjs')
    sqliteOperation(plan, 'check-restore')
    if (!state.restoring && !state.restored) {
      for (const target of plan.targets) {
        const item = state.items[targetKey(target)]
        await recycleIO().verifyRecycledTarget(target, item.receipt, item.operationId)
      }
      checkIndices(plan, true)
      state.restoring = true
      save(journal, state)
    }
    checkIndices(plan, true)
    for (const target of plan.targets) {
      await assertSafePath(dirname(target.path), plan.home)
      await restoreRecycledTree(state.items[targetKey(target)].receipt, target)
    }
    if (process.platform === 'darwin')
      releaseRestoredLocks = acquireMacSessionLocks(
        plan.targets.filter((t) => !alreadyLocked.has(t.path)),
      )
    await assertDesktopStopped(plan.executable, plan.home)
    sqliteOperation(plan, 'restore')
    for (const index of plan.indices) {
      await assertSafePath(index.path, plan.home)
      const bytes = readFileSync(index.path)
      if (digest(bytes) === index.sha256) continue
      if (digest(bytes) !== index.afterSha256) throw Error('索引已变化，保留现场：' + index.path)
      atomicWrite(index.path, Buffer.from(index.bytes, 'base64'))
    }
    for (const target of plan.targets)
      if (!equal(await safeTree(target.path), target.tree)) throw Error('恢复内容不匹配')
    checkIndices(plan, false)
    sqliteOperation(plan, 'verify-restored')
    state.restored = true
    state.restoring = false
    save(journal, state)
    return { restored: plan.targetSessionIds, verified: true }
  } finally {
    await releaseRestoredLocks?.()
    await releaseSessionLocks?.()
    unlinkSync(lock)
  }
}
export { loadDshSnapshot }
export function discoverCleanupInstall() {
  const root =
    process.env.OPL_SUITE_ROOT ??
    (process.platform === 'win32'
      ? join(process.env.APPDATA, 'OPL DSH Suite')
      : join(homedir(), 'Library/Application Support/OPL DSH Suite'))
  const home = process.env.OPL_DSH_HOME ?? join(homedir(), '.dsh')
  const paths = [join(root, 'installation.json'), join(home, 'opl-dsh', 'installation.json')]
  let result
  for (const path of paths) {
    let raw
    try {
      raw = readFileSync(path, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    const r = JSON.parse(raw)
    if (
      ![r.profileHome, r.app, r.cleanupSkillDir].every(
        (s) => typeof s === 'string' && isAbsolute(s),
      )
    )
      throw Error('安装回执缺少有效路径：' + path)
    const next = {
      home: r.profileHome,
      executable: join(
        r.app,
        process.platform === 'win32' ? 'DeepSeek Harness.exe' : 'Contents/MacOS/DeepSeek Harness',
      ),
      launcher: r.launcher,
      version: r.suiteVersion,
      skill: r.cleanupSkillDir,
    }
    if (result && !equal(result, next)) throw Error('安装回执不一致，请指定 --home 和 --executable')
    result = next
  }
  if (!result) throw Error('未找到安装回执：' + paths.join('；'))
  return result
}
async function desktopStatus() {
  const install = discoverCleanupInstall()
  try {
    await assertDesktopStopped(install.executable, install.home)
    return { desktop: 'stopped' }
  } catch {
    /* An existing Desktop requires a positive live activity observation. */
  }
  const b = JSON.parse(readFileSync(join(install.home, 'profiles/desktop/control.json'), 'utf8'))
  const url = new URL(b.endpoint)
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw Error('无效的本地 Desktop 接口')
  const query = async (namespace, method, args) => {
    const res = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      headers: { authorization: 'Bearer ' + b.token, 'content-type': 'application/json' },
      body: JSON.stringify({ namespace, method, args, timeoutMs: 10000 }),
      signal: AbortSignal.timeout(12000),
    })
    const body = await res.json()
    if (!res.ok || !body.ok) throw Error('无法核实 ' + namespace + ' 状态')
    return body.value
  }
  const [native, external, tasks] = await Promise.all([
    query('session', 'list', { _request: {} }),
    query('harness', 'list', {}),
    query('taskFeedback', 'tasks', {}),
  ])
  const terminal = (state) => ['completed', 'cancelled', 'failed'].includes(state)
  const active =
    native.items.filter((s) => s.running !== false).length +
    external.sessions.filter(
      (s) =>
        !(terminal(s.state) || s.state === 'idle') ||
        !Array.isArray(s.approvals) ||
        s.approvals.length ||
        !Array.isArray(s.turns) ||
        s.turns.some((t) => !terminal(t.state) && t.state !== 'idle'),
    ).length +
    tasks.filter((t) => !terminal(t.state)).length
  return {
    desktop: 'running',
    activity: active ? 'busy-or-unknown' : 'idle',
    active,
    native: native.items.length,
    external: external.sessions.length,
    tasks: tasks.length,
  }
}
async function quitWindowsDesktop() {
  if (process.platform !== 'win32') throw Error('该命令仅用于 Windows')
  const install = discoverCleanupInstall()
  const bindingPath = join(install.home, 'profiles/desktop/control.json')
  const before = readFileSync(bindingPath)
  const status = await desktopStatus()
  if (status.desktop === 'stopped') return status
  if (status.activity !== 'idle' || !before.equals(readFileSync(bindingPath)))
    throw Error('Desktop 状态已变化或有活动任务')
  const pid = JSON.parse(before).pid
  if (!Number.isSafeInteger(pid) || pid <= 0) throw Error('Desktop PID 无效')
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      fileURLToPath(new URL('./quit-windows.ps1', import.meta.url)),
      String(pid),
      install.executable,
    ],
    { windowsHide: true, timeout: 35000 },
  )
  await assertDesktopStopped(install.executable, install.home)
  return { desktop: 'stopped' }
}
const help =
  'status | quit --confirmed (Windows) | preview (--archived | --title 精确标题 | --id 会话ID | --selector-file 文件) [--plan 文件] [--home 路径 --executable 路径]\nexecute [--reopen] | resume | restore | verify --plan 文件 --hash 预览哈希'
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2)
  const run = async () => {
    if (!command || command === '--help' || args.includes('--help')) return help
    if (command === 'quit' && args.length === 1 && args[0] === '--confirmed')
      return quitWindowsDesktop()
    if (command === 'status' && !args.length) return desktopStatus()
    if (!['preview', 'execute', 'resume', 'restore', 'verify'].includes(command)) throw Error(help)
    const optionSpec =
      command === 'preview'
        ? {
            archived: { type: 'boolean' },
            title: { type: 'string' },
            id: { type: 'string' },
            'selector-file': { type: 'string' },
            home: { type: 'string' },
            executable: { type: 'string' },
            plan: { type: 'string' },
          }
        : command === 'execute'
          ? { plan: { type: 'string' }, hash: { type: 'string' }, reopen: { type: 'boolean' } }
          : { plan: { type: 'string' }, hash: { type: 'string' } }
    let parsed
    try {
      parsed = parseArgs({
        args,
        options: optionSpec,
        strict: true,
        allowPositionals: false,
        tokens: true,
      })
    } catch (error) {
      if (error?.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE')
        throw Error('缺少参数值：' + error.message)
      throw Error('未知或重复参数：' + error.message)
    }
    const options = new Map()
    for (const token of parsed.tokens ?? []) {
      if (token.kind !== 'option' || token.inlineValue)
        throw Error('未知或重复参数：' + token.rawName)
      const key = token.rawName
      if (options.has(key)) throw Error('未知或重复参数：' + key)
      const v = optionSpec[token.name]?.type === 'boolean' ? true : token.value
      if (!v || (typeof v === 'string' && v.startsWith('--'))) throw Error('缺少参数值：' + key)
      options.set(key, v)
    }
    const value = (key) => options.get(key)
    if (command === 'preview') {
      if (
        ['--archived', '--title', '--id', '--selector-file'].filter((key) => options.has(key))
          .length !== 1
      )
        throw Error('请指定一个预览范围：--archived、--title、--id 或 --selector-file')
      if (options.has('--home') !== options.has('--executable'))
        throw Error('--home 和 --executable 必须一起指定')
      const install = options.has('--home')
        ? { home: value('--home'), executable: value('--executable') }
        : discoverCleanupInstall()
      const planFile =
        value('--plan') ?? join(mkdtempSync(join(tmpdir(), 'opl-cleanup-')), 'plan.json')
      const plan = await previewCleanup({
        ...install,
        title: value('--title'),
        planFile,
        selector: options.has('--selector-file')
          ? JSON.parse(readFileSync(value('--selector-file'), 'utf8'))
          : options.has('--id')
            ? { kind: 'ids', sessionIds: [value('--id')] }
            : { kind: 'archived' },
      })
      return {
        planHash: plan.planHash,
        planFile,
        sessionCount: plan.sessions.length,
        sessions: plan.sessions,
        protectedSessionIds: plan.protectedSessionIds,
        targets: plan.targets.map(({ id, kind }) => ({ id, kind })),
        skipped: plan.skipped,
        blockers: plan.blockers,
        stats: plan.stats,
      }
    }
    if (!value('--plan') || !value('--hash')) throw Error('必须指定 --plan 和 --hash')
    const plan = JSON.parse(readFileSync(value('--plan'), 'utf8'))
    const request = { plan, expectedHash: value('--hash'), resume: command === 'resume' }
    if (command === 'execute' && options.has('--reopen')) {
      const install = discoverCleanupInstall()
      if (
        process.platform !== 'win32' ||
        !isAbsolute(install.launcher ?? '') ||
        !install.launcher.toLowerCase().endsWith('.vbs') ||
        !existsSync(install.launcher) ||
        resolve(plan.home) !== resolve(install.home) ||
        resolve(plan.executable) !== resolve(install.executable)
      )
        throw Error('重开入口与计划不一致')
      const report = await executeDshCleanup(request)
      try {
        execFileSync('wscript.exe', [install.launcher], { windowsHide: true, timeout: 30000 })
        const deadline = Date.now() + 30000
        do {
          try {
            if ((await desktopStatus()).desktop === 'running') return { ...report, reopened: true }
          } catch {
            /* Host is starting. */
          }
          await new Promise((done) => setTimeout(done, 500))
        } while (Date.now() < deadline)
      } catch {
        /* Report cleanup independently from launcher failure. */
      }
      return {
        ...report,
        reopened: false,
        warning: '回收已验证，未确认 Desktop 重新打开；请勿重复回收',
      }
    }
    if (command === 'execute' || command === 'resume') return executeDshCleanup(request)
    if (command === 'restore') return restoreCleanup(request)
    if (command === 'verify') return verifyCleanup(request)
    throw Error('用法: preview | execute | resume | verify')
  }
  run()
    .then((result) =>
      console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2)),
    )
    .catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
}
