/** Plan-bound DSH cleanup. It only recycles an exact, offline-verified target set. */
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  lstatSync,
  statSync,
  readdirSync,
  renameSync,
  openSync,
  closeSync,
  unlinkSync,
  fsyncSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { loadDshSnapshot } from './snapshot.mjs'
import {
  assertDesktopStopped,
  safeTree,
  assertSafePath,
  recycleTarget,
  findRecycledTarget,
  verifyRecycledTarget,
} from './windows-io.mjs'

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
  const temporary = path + '.' + randomUUID() + '.tmp'
  const fd = openSync(temporary, 'wx', 0o600)
  try {
    writeFileSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temporary, path)
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
export async function previewCleanup({ home, selector, planFile, executable }) {
  const started = performance.now()
  if (!home || !executable) throw Error('必须指定数据根和 Desktop 可执行文件')
  home = resolve(home)
  executable = resolve(executable)
  await assertDesktopStopped(executable, home)
  const snapshot = await loadDshSnapshot({ home, selector })
  await assertDesktopStopped(executable, home)
  const plan = buildCleanupPlan({ ...snapshot, home, selector })
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
}
/** Recycle exact targets, persist every intent/receipt, then CAS the indices. */
export async function executeDshCleanup({ plan, expectedHash, mode = 'recycle', resume = false }) {
  assertPlan(plan, expectedHash)
  if (mode !== 'recycle') throw Error('没有可用的永久删除协议')
  if (!isAbsolute(plan.executable ?? '')) throw Error('Desktop 可执行文件缺失')
  await assertDesktopStopped(plan.executable, plan.home)
  for (const target of plan.targets)
    if (existsSync(target.path)) await assertSafePath(target.path, plan.home)
  const history = join(plan.home, 'cleanup-history')
  mkdirSync(history, { recursive: true, mode: 0o700 })
  await assertSafePath(history, plan.home)
  const journal = join(history, plan.planHash + '.json')
  const lock = join(history, 'operation.lock')
  acquireLock(lock, plan.planHash, resume)
  const started = performance.now()
  try {
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
    // Recover a receipt if the process stopped after the recycle call.
    for (const target of plan.targets) {
      const item = state.items[targetKey(target)]
      if (item && !existsSync(target.path)) {
        item.receipt ??= await findRecycledTarget(target, item.sinceMs)
        await verifyRecycledTarget(target, item.receipt)
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
        await verifyRecycledTarget(target, state.items[key].receipt)
        continue
      }
      checkIndices(plan, false)
      if (!equal(await safeTree(target.path), target.tree))
        throw Error('目标内容已变化: ' + target.id)
      state.items[key] = { sinceMs: Date.now() }
      save(journal, state)
      state.items[key].receipt = await recycleTarget(target)
      await verifyRecycledTarget(target, state.items[key].receipt)
      state.items[key].completed = true
      save(journal, state)
    }
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
    state.indicesCommitted = true
    save(journal, state)
    const report = await verifyCleanup({ plan, expectedHash, skipProcessCheck: true })
    return { ...report, journal, elapsedMs: Math.round(performance.now() - started) }
  } finally {
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
  if (!state.indicesCommitted || state.planHash !== plan.planHash)
    throw Error('清理尚未完成，请使用 resume')
  for (const target of plan.targets) {
    if (existsSync(target.path)) throw Error('目标仍存在: ' + target.id)
    await verifyRecycledTarget(target, state.items[targetKey(target)]?.receipt)
  }
  for (const index of plan.indices)
    if (digest(readFileSync(index.path)) !== index.afterSha256) throw Error('索引验收失败')
  checkInventoryFast(plan, plan.targets.map(targetKey))
  return {
    targetCount: plan.targets.length,
    protectedCount: plan.protectedSessionIds.length,
    skipped: plan.skipped,
    verified: true,
  }
}
export { loadDshSnapshot }
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2)
  const value = (flag) => {
    const index = args.indexOf(flag)
    return index < 0 ? undefined : args[index + 1]
  }
  const run = async () => {
    if (command === 'preview') {
      const plan = await previewCleanup({
        home: value('--home'),
        executable: value('--executable'),
        selector: JSON.parse(readFileSync(value('--selector-file'), 'utf8')),
        planFile: value('--plan'),
      })
      return {
        planHash: plan.planHash,
        targets: plan.targets.map(({ id, kind }) => ({ id, kind })),
        skipped: plan.skipped,
        blockers: plan.blockers,
        stats: plan.stats,
      }
    }
    const plan = JSON.parse(readFileSync(value('--plan'), 'utf8'))
    const options = { plan, expectedHash: value('--hash'), resume: command === 'resume' }
    if (command === 'execute' || command === 'resume') return executeDshCleanup(options)
    if (command === 'verify') return verifyCleanup(options)
    throw Error('用法: preview | execute | resume | verify')
  }
  run()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
}
