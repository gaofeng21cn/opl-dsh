import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, open, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createZstdDecompress } from 'node:zlib'

const SESSION_FILE_RE = /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/
const ACTIVE_TASK_STATES = new Set([
  'queued',
  'accepted',
  'running',
  'waiting_approval',
  'waiting_input',
  'waiting_child',
  'interrupted',
])
const KNOWN_EDIT_DIRECTORIES = [
  'stop-edit-intents',
  'message-edit-intents',
  'external-message-edit-intents',
  'external-edit-intents',
]
const INDEX_NAMES = ['combination-selection.json', 'external-effort-selection.json']
const MAX_HEADER_BYTES = 1024 * 1024

/**
 * Read an installed DSH home into a deterministic, read-only cleanup snapshot.
 *
 * The scanner never writes, starts a process, resolves user supplied paths, or
 * follows a link. It hashes only native sessions and external records selected
 * by `selector` (including the native session closure of external IDs).
 *
 * @param {{home?: string, selector: object}} options - DSH home and exact selection.
 * @returns {Promise<object>} snapshot with workspace, records, index baselines, blockers and stats.
 */
export async function loadDshSnapshot({
  home = process.env.DSH_HOME ?? join(homedir(), '.dsh'),
  selector,
} = {}) {
  if (!selector || typeof selector !== 'object') throw new Error('selector is required')
  validateSelectorIds(selector)
  const root = await safeRoot(home)
  const blockers = []
  const stats = {
    targetHashBytes: 0,
    targetHashFiles: 0,
    inventoryFiles: 0,
    headerBytesRead: 0,
    fullLogBytesRead: 0,
  }

  const workspacePath = await safeChild(root, 'storages', 'workspace.json')
  const workspaceBytes = await readRequired(workspacePath, blockers, 'workspace-missing')
  const workspaceRaw = parseJson(workspaceBytes, workspacePath, blockers, 'workspace-invalid')
  const workspace = normalizeWorkspace(workspaceRaw, workspacePath, blockers)

  const sessionRoot = await safeChild(root, 'sessions')
  const sessionEntries = await readDirectory(sessionRoot, blockers, 'sessions-missing')
  const sessions = []
  const nativeById = new Map()
  for (const namespace of sessionEntries) {
    if (namespace.name === '.index-cache') continue
    await ensureSafeEntry(sessionRoot, namespace, blockers)
    if (!namespace.isDirectory()) {
      blockers.push({
        code: 'session-root-unknown-entry',
        path: join(sessionRoot, namespace.name),
        detail: 'session root contains a non-directory entry',
      })
      continue
    }
    const namespacePath = join(sessionRoot, namespace.name)
    const entries = await readDirectory(namespacePath, blockers, 'session-namespace-unreadable')
    for (const entry of entries) {
      await ensureSafeEntry(namespacePath, entry, blockers)
      if (!entry.isDirectory()) {
        blockers.push({
          code: 'session-namespace-unknown-entry',
          path: join(namespacePath, entry.name),
          detail: 'namespace contains a non-directory entry',
        })
        continue
      }
      const path = join(namespacePath, entry.name)
      const record = await inspectSession(path, entry.name, blockers, stats)
      if (record === undefined) continue
      const identityId = record.headerId ?? record.id
      if (nativeById.has(identityId)) {
        throw new Error(`duplicate native session id: ${identityId}`)
      }
      nativeById.set(identityId, record)
      sessions.push(record)
    }
  }
  sessions.sort((left, right) => left.id.localeCompare(right.id))

  const externalRecords = await inspectExternalRecords(root, blockers, stats)
  const externalById = new Map()
  for (const record of externalRecords) {
    if (externalById.has(record.id)) throw new Error(`duplicate external record id: ${record.id}`)
    externalById.set(record.id, record)
  }

  const taskState = await inspectTaskFeedback(root, blockers)
  const sidecarRefs = await inspectSidecars(root, blockers)
  applyReferences(sessions, externalRecords, taskState, sidecarRefs)

  const selection = resolveSelection(selector, workspace, sessions, externalRecords, blockers)
  const targetNativeIds = new Set(selection.nativeIds)
  const targetExternalIds = new Set(selection.externalIds)
  // Removing a native session while retaining its OPL record leaves a record
  // that can be imported again. The native closure therefore includes every
  // external record that names a selected native session.
  for (const record of externalRecords) {
    if (record.nativeSessionId && targetNativeIds.has(record.nativeSessionId))
      targetExternalIds.add(record.id)
  }
  for (const session of sessions) {
    const targeted = targetNativeIds.has(session.id)
    if (!session.legacy && session.header !== undefined) {
      if (targeted) session.tree = await hashTree(session.path, stats)
      // Read every generation to discover references from retained sessions;
      // only selected trees are hashed for the plan.
      await validateTargetLogs(session, stats, blockers)
    }
  }
  rebuildLogLineage(sessions, blockers)
  for (const record of externalRecords) {
    if (targetExternalIds.has(record.id)) record.tree = await hashTree(record.path, stats)
  }

  const indices = []
  for (const path of await knownIndexPaths(root)) {
    const bytes = await readFile(path)
    const encoded = bytes.toString('base64')
    const sha256 = digest(bytes)
    indices.push({
      path,
      bytes: encoded,
      sha256,
    })
  }
  indices.sort((left, right) => left.path.localeCompare(right.path))

  for (const session of sessions) {
    delete session.header
    delete session.headerId
    session.taskRefs = [...new Set(session.taskRefs)].sort()
    session.lineageRefs = [...new Set(session.lineageRefs)].sort()
    session.blockers = [...new Set(session.blockers)].sort()
    if (session.tree === undefined) delete session.tree
  }
  for (const record of externalRecords) {
    delete record.references
    record.taskRefs = [...new Set(record.taskRefs)].sort()
    record.lineageRefs = [...new Set(record.lineageRefs)].sort()
    record.blockers = [...new Set(record.blockers)].sort()
    if (record.tree === undefined) delete record.tree
  }

  // Keep global storage-format and safety blockers visible, while scoping
  // record-local blockers to the exact identities selected for this snapshot.
  // An opaque legacy session must protect itself without preventing cleanup of
  // an unrelated, fully readable session in the same DSH home.
  const selectedIds = new Set([...targetNativeIds, ...targetExternalIds])
  const effectiveBlockers = blockers.filter(
    (blocker) =>
      [
        'selected-session-log-invalid',
        'session-log-invalid',
        'session-log-unreadable',
        'session-header-malformed',
        'session-header-missing',
        'session-header-unknown',
      ].includes(blocker.code) ||
      (blocker.id === undefined && blocker.nativeSessionId === undefined) ||
      selectedIds.has(blocker.id) ||
      selectedIds.has(blocker.nativeSessionId),
  )

  return {
    home: root,
    workspace: {
      path: workspacePath,
      archivedSessionIds: workspace.archivedSessionIds,
      pinnedSessionIds: workspace.pinnedSessionIds,
      workspaceIds: workspace.workspaceIds,
      workspaces: workspace.workspaces,
    },
    sessions,
    externalRecords,
    indices,
    blockers: effectiveBlockers,
    stats,
  }
}

function rebuildLogLineage(sessions, blockers) {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  for (const session of sessions) {
    for (const referenced of [...new Set(session.lineageRefs ?? [])]) {
      if (referenced === session.id) continue
      const parent = byId.get(referenced)
      if (!parent) {
        blockers.push({ code: 'lineage-reference-unknown', id: session.id, detail: referenced })
        session.blockers.push('lineage-reference-unknown')
        continue
      }
      parent.lineageRefs ??= []
      if (!parent.lineageRefs.includes(session.id)) parent.lineageRefs.push(session.id)
    }
  }
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function safeRoot(value) {
  if (typeof value !== 'string' || !value) throw new Error('home must be a non-empty path')
  const root = resolve(value)
  await assertNoLinks(root)
  return root
}

async function safeChild(root, ...parts) {
  if (
    parts.some(
      (part) =>
        typeof part !== 'string' || part === '' || part.includes('\\') || part.includes('/'),
    )
  ) {
    throw new Error('unsafe relative path component')
  }
  const path = resolve(root, ...parts)
  if (!isWithin(root, path)) throw new Error(`path escapes DSH home: ${path}`)
  await assertNoLinks(path, { allowMissing: true })
  return path
}

async function assertNoLinks(path, { allowMissing = false } = {}) {
  const absolute = resolve(path)
  let current = absolute
  for (;;) {
    try {
      const item = await lstat(current, { bigint: false })
      if (item.isSymbolicLink())
        throw new Error(`symbolic link or reparse point is not allowed: ${current}`)
      const canonical = await realpath(current)
      const same =
        process.platform === 'win32'
          ? canonical.toLowerCase() === resolve(current).toLowerCase()
          : canonical === resolve(current)
      if (!same) throw new Error(`reparse point is not allowed: ${current}`)
    } catch (error) {
      if (allowMissing && error?.code === 'ENOENT') {
        // A missing leaf is allowed for optional stores; its existing parents
        // are still checked on the following iterations.
      } else throw error
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
}

function validateSelectorIds(selector) {
  const values = []
  if (selector.kind === 'ids')
    values.push(...(selector.sessionIds ?? []), ...(selector.externalIds ?? []))
  if (selector.kind === 'workspace' || selector.kind === 'workspaces')
    values.push(...(selector.workspaceIds ?? []))
  values.push(...(selector.excludeSessionIds ?? selector.excludeIds ?? []))
  if (values.some((value) => typeof value !== 'string' || !isSafeId(value))) {
    throw new Error('selector contains an unsafe ID')
  }
}

async function readDirectory(path, blockers, code, { optional = false } = {}) {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') {
      if (!optional) blockers.push({ code, path, detail: 'directory is absent' })
      return []
    }
    blockers.push({ code, path, detail: String(error) })
    return []
  }
}

async function readOptionalDirectory(path, blockers, code) {
  return readDirectory(path, blockers, code, { optional: true })
}

function isWithin(root, path) {
  const value = relative(root, path)
  return (
    value === '' ||
    (value !== '..' &&
      !value.startsWith(`..${path.includes('\\') ? '\\' : '/'}`) &&
      !isAbsolute(value))
  )
}

async function ensureSafeEntry(parent, entry, blockers) {
  const entryPath = join(parent, entry.name)
  if (entry.isSymbolicLink()) {
    blockers.push({
      code: 'link-entry',
      path: entryPath,
      detail: 'link/reparse entries are opaque',
    })
    throw new Error(`symbolic link or reparse point is not allowed: ${entryPath}`)
  }
  try {
    const [parentReal, entryReal] = await Promise.all([realpath(parent), realpath(entryPath)])
    if (
      !isWithin(parentReal, entryReal) ||
      (entry.isDirectory() && entryReal.toLowerCase() !== resolve(entryPath).toLowerCase())
    ) {
      blockers.push({
        code: 'reparse-entry',
        path: entryPath,
        detail: 'reparse or junction entry is opaque',
      })
      throw new Error(`reparse or junction entry is not allowed: ${entryPath}`)
    }
  } catch (error) {
    if (error?.code === 'ENOENT') throw error
    if (String(error?.message ?? '').includes('reparse or junction')) throw error
    throw new Error(`cannot resolve entry safely: ${entryPath}`)
  }
}

async function readRequired(path, blockers, code) {
  try {
    return await readFile(path)
  } catch (error) {
    blockers.push({ code, path, detail: String(error) })
    return Buffer.from('')
  }
}

function parseJson(bytes, path, blockers, code) {
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    blockers.push({ code, path, detail: String(error) })
    return undefined
  }
}

function normalizeWorkspace(raw, path, blockers) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    blockers.push({ code: 'workspace-invalid', path, detail: 'workspace root must be an object' })
    return { archivedSessionIds: [], pinnedSessionIds: [], workspaceIds: [], workspaces: {} }
  }
  const global = raw.global
  const tables = raw.tables
  if (raw.unit?.name !== 'workspace' || raw.unit?.version !== 2) {
    blockers.push({
      code: 'workspace-unit-unsupported',
      path,
      detail: 'expected workspace storage unit version 2',
    })
  }
  const archivedSessionIds = arrayOfStrings(
    global?.archivedSessionIds,
    path,
    'archivedSessionIds',
    blockers,
  )
  const pinnedSessionIds = arrayOfStrings(
    global?.pinnedSessionIds,
    path,
    'pinnedSessionIds',
    blockers,
  )
  const workspaceIds = arrayOfStrings(global?.workspaceIds, path, 'workspaceIds', blockers)
  const workspaces = tables?.workspaces
  if (!workspaces || typeof workspaces !== 'object' || Array.isArray(workspaces)) {
    blockers.push({
      code: 'workspace-table-invalid',
      path,
      detail: 'tables.workspaces must be an object',
    })
  }
  const normalizedWorkspaces = {}
  for (const id of workspaceIds) {
    const value = workspaces?.[id]
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      blockers.push({
        code: 'workspace-definition-missing',
        path,
        id,
        detail: 'workspace id has no definition',
      })
      continue
    }
    normalizedWorkspaces[id] = {
      ...value,
      sessionIds: arrayOfStrings(value.sessionIds, path, `${id}.sessionIds`, blockers),
    }
  }
  for (const [id, value] of Object.entries(workspaces ?? {})) {
    if (normalizedWorkspaces[id] !== undefined) continue
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      normalizedWorkspaces[id] = {
        ...value,
        sessionIds: arrayOfStrings(value.sessionIds, path, `${id}.sessionIds`, blockers),
      }
    }
  }
  return { archivedSessionIds, pinnedSessionIds, workspaceIds, workspaces: normalizedWorkspaces }
}

function arrayOfStrings(value, path, label, blockers) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    blockers.push({
      code: 'workspace-field-invalid',
      path,
      detail: `${label} must be a string array`,
    })
    return []
  }
  if (value.some((item) => !isSafeId(item))) {
    blockers.push({ code: 'workspace-id-invalid', path, detail: `${label} contains an unsafe ID` })
  }
  return [...value]
}

async function inspectSession(path, directoryId, blockers, stats) {
  if (!isSafeId(directoryId)) {
    blockers.push({
      code: 'session-directory-id-invalid',
      id: directoryId,
      path,
      detail: 'directory name is not a safe session ID',
    })
  }
  const entries = await readDirectory(path, blockers, 'session-directory-unreadable')
  const files = await inventoryTree(path, '', stats, blockers)
  files.sort((left, right) => left.path.localeCompare(right.path))
  const sessionFiles = entries
    .filter((entry) => entry.isFile() && SESSION_FILE_RE.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))
  const unknownSidecars = entries.filter(
    (entry) => entry.isFile() && !SESSION_FILE_RE.test(entry.name),
  )
  const legacy = directoryId.startsWith('session_')
  if (legacy) {
    blockers.push({
      code: 'legacy-session-directory',
      id: directoryId,
      path,
      detail: 'legacy session_ directory is opaque and protected',
    })
    return {
      id: directoryId,
      path,
      active: false,
      taskRefs: [],
      lineageRefs: [],
      blockers: ['legacy-session-directory'],
      files,
      legacy: true,
    }
  }
  if (unknownSidecars.length > 0) {
    blockers.push({
      code: 'unknown-session-sidecar',
      id: directoryId,
      path,
      detail: unknownSidecars.map((item) => item.name).join(', '),
    })
  }
  if (sessionFiles.length === 0) {
    blockers.push({
      code: 'session-header-missing',
      id: directoryId,
      path,
      detail: 'no recognized session JSONL generation',
    })
    return {
      id: directoryId,
      path,
      active: false,
      taskRefs: [],
      lineageRefs: [],
      blockers: ['session-header-missing'],
      files,
    }
  }
  const headers = []
  try {
    for (const file of sessionFiles)
      headers.push(await readHeader(join(path, file.name), false, stats))
  } catch (error) {
    blockers.push({
      code: 'session-header-malformed',
      id: directoryId,
      path,
      detail: String(error),
    })
    return {
      id: directoryId,
      path,
      active: false,
      taskRefs: [],
      lineageRefs: [],
      blockers: ['session-header-malformed'],
      files,
    }
  }
  const header = headers.at(-1)
  if (
    !header ||
    header.type !== 'session' ||
    typeof header.id !== 'string' ||
    !isSafeId(header.id) ||
    !Number.isInteger(header.version) ||
    header.version < 0 ||
    header.version > 4 ||
    typeof header.isSeeded !== 'boolean'
  ) {
    blockers.push({
      code: 'session-header-unknown',
      id: directoryId,
      path,
      detail: 'header does not identify a session',
    })
    return {
      id: directoryId,
      path,
      active: false,
      taskRefs: [],
      lineageRefs: [],
      blockers: ['session-header-unknown'],
      files,
    }
  }
  if (header.id !== directoryId) {
    blockers.push({
      code: 'session-directory-id-mismatch',
      id: directoryId,
      path,
      detail: `header id is ${header.id}`,
    })
  }
  for (const value of headers) {
    if (
      value?.type !== 'session' ||
      value.id !== directoryId ||
      !Number.isInteger(value.version) ||
      value.version < 0 ||
      value.version > 4 ||
      typeof value.isSeeded !== 'boolean'
    ) {
      blockers.push({
        code: 'session-header-unknown',
        id: directoryId,
        path,
        detail: 'a stored generation header is unsupported',
      })
    }
  }
  const lineageRefs = headers
    .flatMap((value) => [value?.parentSession, value?.origin?.sessionId])
    .filter((value) => typeof value === 'string' && value !== directoryId)
  return {
    id: directoryId,
    path,
    active: false,
    taskRefs: [],
    lineageRefs,
    blockers: header.id === directoryId ? [] : ['session-directory-id-mismatch'],
    files,
    header,
    headerId: header.id,
  }
}

async function inventoryFile(path) {
  const item = await stat(path, { bigint: true })
  return { path, size: Number(item.size), mtimeNs: item.mtimeNs.toString() }
}

async function inventoryTree(root, prefix, stats, blockers) {
  const result = []
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    await ensureSafeEntry(root, entry, blockers)
    const path = join(root, entry.name)
    await assertNoLinks(path)
    const name = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) result.push(...(await inventoryTree(path, name, stats, blockers)))
    else if (entry.isFile()) {
      result.push(await inventoryFile(path))
      stats.inventoryFiles++
    } else {
      blockers.push({
        code: 'session-unknown-entry',
        path,
        detail: 'session tree contains a non-file entry',
      })
    }
  }
  return result
}

async function inspectExternalRecords(root, blockers, stats) {
  const directory = await safeChild(root, 'profiles', 'desktop', 'harness-sessions')
  const entries = await readOptionalDirectory(directory, blockers, 'external-directory-unreadable')
  const records = []
  for (const entry of entries) {
    await ensureSafeEntry(directory, entry, blockers)
    if (
      !entry.isFile() ||
      !entry.name.endsWith('.json') ||
      entry.name === 'migration-complete.json'
    ) {
      if (entry.isFile() && entry.name !== 'migration-complete.json') {
        blockers.push({
          code: 'unknown-external-sidecar',
          path: join(directory, entry.name),
          detail: 'external record directory contains an unknown sidecar',
        })
      }
      continue
    }
    const path = join(directory, entry.name)
    const files = [await inventoryFile(path)]
    stats.inventoryFiles++
    const value = parseJson(await readFile(path), path, blockers, 'external-record-invalid')
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      typeof value.id !== 'string'
    ) {
      blockers.push({
        code: 'external-record-unknown',
        path,
        detail: 'record must have a string id',
      })
      continue
    }
    if (!isSafeId(value.id)) {
      blockers.push({
        code: 'external-id-invalid',
        id: value.id,
        path,
        detail: 'record id is not safe',
      })
    }
    const nativeSessionId =
      typeof value.nativeSessionId === 'string' ? value.nativeSessionId : undefined
    if (nativeSessionId !== undefined && !isSafeId(nativeSessionId)) {
      blockers.push({
        code: 'external-native-id-invalid',
        id: value.id,
        path,
        detail: nativeSessionId,
      })
    }
    records.push({
      id: value.id,
      nativeSessionId,
      path,
      active:
        Array.isArray(value.turns) &&
        value.turns.some((turn) => ACTIVE_TASK_STATES.has(turn?.state)),
      taskRefs: [],
      lineageRefs: [],
      blockers: nativeSessionId === undefined ? ['external-native-reference-unknown'] : [],
      files,
      references: externalLineageReferences(value),
    })
    if (
      Array.isArray(value.turns) &&
      value.turns.some(
        (turn) =>
          turn?.state !== undefined &&
          !ACTIVE_TASK_STATES.has(turn.state) &&
          !['idle', 'completed', 'failed', 'cancelled'].includes(turn.state),
      )
    ) {
      records.at(-1).blockers.push('external-state-unknown')
      blockers.push({
        code: 'external-state-unknown',
        id: value.id,
        path,
        detail: 'record has an unknown turn state',
      })
    }
  }
  // The migration predecessor is intentionally opaque: deleting a modern file
  // while leaving this array would silently resurrect it on the next startup.
  const legacyPath = await safeChild(root, 'profiles', 'desktop', 'harness-sessions.json')
  try {
    const item = await lstat(legacyPath)
    if (item.isSymbolicLink())
      throw new Error(`symbolic link or reparse point is not allowed: ${legacyPath}`)
    blockers.push({
      code: 'legacy-external-records',
      path: legacyPath,
      detail: 'legacy harness-sessions.json is protected',
    })
  } catch (error) {
    if (error?.code !== 'ENOENT')
      blockers.push({
        code: 'legacy-external-records-unreadable',
        path: legacyPath,
        detail: String(error),
      })
  }
  records.sort((left, right) => left.id.localeCompare(right.id))
  return records
}

async function inspectTaskFeedback(root, blockers) {
  const path = await safeChild(root, 'storages', 'task_feedback.json')
  let value
  try {
    value = JSON.parse((await readFile(path)).toString('utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return { refs: [] }
    blockers.push({ code: 'task-feedback-invalid', path, detail: String(error) })
    return { refs: [] }
  }
  const refs = []
  walkReferences(value, (reference) => {
    if (reference.key === 'sessionId' && typeof reference.value === 'string') {
      const record = reference.record
      if (reference.value !== '')
        refs.push({
          sessionId: reference.value,
          taskId: typeof record?.taskId === 'string' ? record.taskId : undefined,
          state: typeof record?.state === 'string' ? record.state : undefined,
          active: ACTIVE_TASK_STATES.has(record?.state),
          path,
        })
    }
  })
  walkReferences(value, (reference) => {
    if (reference.key === 'harnessSessionId' && typeof reference.value === 'string') {
      refs.push({
        externalSessionId: reference.value,
        taskId: reference.record?.taskId,
        state: reference.record?.state,
        active: ACTIVE_TASK_STATES.has(reference.record?.state),
        path,
      })
    }
  })
  return { refs }
}

async function inspectSidecars(root, blockers) {
  const refs = []
  for (const name of INDEX_NAMES) {
    const path = await safeChild(root, 'profiles', 'desktop', name)
    try {
      const value = JSON.parse((await readFile(path)).toString('utf8'))
      if (
        name === 'combination-selection.json' &&
        value &&
        typeof value === 'object' &&
        !Array.isArray(value)
      ) {
        for (const key of Object.keys(value)) {
          if (!isSafeId(key))
            blockers.push({ code: 'sidecar-reference-unknown', path, detail: key })
          else refs.push({ sessionId: key, path, kind: 'combination-selection' })
        }
      } else if (
        name === 'external-effort-selection.json' &&
        value &&
        typeof value === 'object' &&
        !Array.isArray(value)
      ) {
        for (const key of Object.keys(value)) {
          try {
            const tuple = JSON.parse(key)
            if (Array.isArray(tuple) && typeof tuple[0] === 'string' && isSafeId(tuple[0]))
              refs.push({ sessionId: tuple[0], path, kind: 'external-effort-selection' })
            else blockers.push({ code: 'sidecar-reference-unknown', path, detail: key })
          } catch (error) {
            blockers.push({ code: 'sidecar-reference-unknown', path, detail: String(error) })
          }
        }
      } else {
        blockers.push({
          code: 'sidecar-invalid',
          path,
          detail: 'known structured map must be an object',
        })
      }
    } catch (error) {
      if (error?.code !== 'ENOENT')
        blockers.push({ code: 'sidecar-invalid', path, detail: String(error) })
    }
  }
  for (const directoryName of KNOWN_EDIT_DIRECTORIES) {
    const directory = await safeChild(root, 'profiles', 'desktop', directoryName)
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      blockers.push({ code: 'edit-directory-unreadable', path: directory, detail: String(error) })
      continue
    }
    for (const entry of entries) {
      await ensureSafeEntry(directory, entry, blockers)
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const path = join(directory, entry.name)
      try {
        const value = JSON.parse((await readFile(path)).toString('utf8'))
        walkReferences(value, (reference) => {
          if (
            ['sessionId', 'nativeSessionId', 'previousSessionId'].includes(reference.key) &&
            typeof reference.value === 'string'
          ) {
            if (!isSafeId(reference.value)) {
              blockers.push({ code: 'sidecar-reference-unknown', path, detail: reference.value })
              return
            }
            refs.push({ sessionId: reference.value, path, kind: directoryName })
          }
        })
      } catch (error) {
        blockers.push({ code: 'edit-record-invalid', path, detail: String(error) })
      }
    }
  }
  return refs
}

function walkReferences(value, callback, record) {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value)
      walkReferences(item, callback, item && typeof item === 'object' ? item : record)
    return
  }
  for (const [key, child] of Object.entries(value)) {
    if (['sessionId', 'nativeSessionId', 'previousSessionId', 'harnessSessionId'].includes(key))
      callback({ key, value: child, record: value })
    if (child && typeof child === 'object') walkReferences(child, callback, child)
  }
}

function externalLineageReferences(value) {
  const refs = []
  if (
    typeof value.origin?.sessionId === 'string' &&
    value.origin.kind !== 'codex' &&
    value.origin.sessionId !== 'legacy'
  )
    refs.push(value.origin.sessionId)
  for (const key of ['previousSessionId', 'sessionId']) {
    if (typeof value.stopEdit?.[key] === 'string') refs.push(value.stopEdit[key])
  }
  return refs
}

function applyReferences(sessions, externalRecords, taskState, sidecarRefs) {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  for (const reference of taskState.refs) {
    if (reference.externalSessionId !== undefined) {
      const record = externalRecords.find((item) => item.id === reference.externalSessionId)
      if (record) {
        record.taskRefs.push(reference.taskId ?? `task_feedback:${reference.externalSessionId}`)
        record.active = record.active || reference.active
      }
      continue
    }
    const session = byId.get(reference.sessionId)
    if (!session) continue
    const taskId =
      typeof reference.taskId === 'string'
        ? reference.taskId
        : `task_feedback:${reference.sessionId}`
    session.taskRefs.push(taskId)
    session.active ||= reference.active
  }
  for (const reference of sidecarRefs) {
    const session = byId.get(reference.sessionId)
    if (!session) continue
    if (reference.kind.includes('intent')) {
      session.blockers.push(`edit-intent-reference:${reference.kind}`)
      session.taskRefs.push(`${reference.kind}:${reference.path}`)
    }
  }
  const lineage = new Map()
  for (const session of sessions) {
    if (!session.header) continue
    const parent = session.header.parentSession ?? session.header.origin?.sessionId
    if (typeof parent !== 'string') {
      if (session.header.isSeeded === true) session.blockers.push('seed-parent-unknown')
      continue
    }
    const related = lineage.get(parent) ?? []
    related.push(session.id)
    lineage.set(parent, related)
    session.lineageRefs.push(parent)
  }
  for (const [parent, children] of lineage) {
    const session = byId.get(parent)
    if (session) {
      session.lineageRefs.push(...children)
    }
  }
  for (const record of externalRecords) {
    const session = record.nativeSessionId ? byId.get(record.nativeSessionId) : undefined
    if (!session) {
      if (record.nativeSessionId) record.blockers.push('native-session-missing')
      continue
    }
    record.active = record.active || session.active
    record.taskRefs = [...record.taskRefs, ...session.taskRefs]
    record.lineageRefs = [...record.lineageRefs, ...session.lineageRefs]
    record.blockers.push(...session.blockers)
    for (const reference of record.references ?? []) {
      if (reference === record.nativeSessionId) continue
      const parent = byId.get(reference)
      if (parent) {
        if (record.nativeSessionId) parent.lineageRefs.push(record.nativeSessionId)
        record.lineageRefs.push(reference)
      } else if (record.references.length)
        record.blockers.push('external-lineage-reference-unknown')
    }
  }
}

function resolveSelection(selector, workspace, sessions, externalRecords, blockers) {
  const nativeIds = new Set()
  const externalIds = new Set()
  const excludes = new Set(
    Array.isArray(selector.excludeSessionIds ?? selector.excludeIds)
      ? (selector.excludeSessionIds ?? selector.excludeIds)
      : [],
  )
  if (selector.kind === 'ids') {
    for (const id of Array.isArray(selector.sessionIds) ? selector.sessionIds : [])
      nativeIds.add(id)
    for (const id of Array.isArray(selector.externalIds) ? selector.externalIds : [])
      externalIds.add(id)
  } else if (selector.kind === 'archived') {
    for (const id of workspace.archivedSessionIds) nativeIds.add(id)
  } else if (selector.kind === 'workspaces' || selector.kind === 'workspace') {
    for (const workspaceId of Array.isArray(selector.workspaceIds) ? selector.workspaceIds : []) {
      const value = workspace.workspaces[workspaceId]
      if (!value)
        blockers.push({
          code: 'workspace-selector-missing',
          id: workspaceId,
          detail: 'workspace is not defined',
        })
      for (const id of value?.sessionIds ?? []) nativeIds.add(id)
    }
  } else {
    throw new Error(`unsupported selector kind: ${String(selector.kind)}`)
  }
  for (const record of externalRecords)
    if (externalIds.has(record.id) && record.nativeSessionId) nativeIds.add(record.nativeSessionId)
  for (const id of excludes) {
    nativeIds.delete(id)
    for (const record of externalRecords)
      if (record.nativeSessionId === id) externalIds.delete(record.id)
  }
  for (const id of nativeIds)
    if (!sessions.some((session) => session.id === id))
      blockers.push({
        code: 'selected-session-missing',
        id,
        detail: 'selected native session is absent',
      })
  for (const record of externalRecords)
    if (record.nativeSessionId && nativeIds.has(record.nativeSessionId)) externalIds.add(record.id)
  for (const id of externalIds)
    if (!externalRecords.some((record) => record.id === id))
      blockers.push({
        code: 'selected-external-missing',
        id,
        detail: 'selected external record is absent',
      })
  return { nativeIds, externalIds }
}

async function hashTree(root, stats) {
  const result = {}
  const rootInfo = await stat(root, { bigint: true })
  if (rootInfo.isFile()) {
    const bytes = await readFile(root)
    result['.'] = { bytes: bytes.length, sha256: digest(bytes) }
    stats.targetHashBytes += bytes.length
    stats.targetHashFiles++
    return result
  }
  const visit = async (current, prefix) => {
    const entries = (await readdir(current, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    )
    if (entries.length === 0 && prefix === '')
      result['./'] = { bytes: 0, sha256: digest(Buffer.alloc(0)) }
    for (const entry of entries) {
      await ensureSafeEntry(current, entry, [])
      const path = join(current, entry.name)
      await assertNoLinks(path)
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        const children = await readdir(path)
        if (children.length === 0)
          result[`${relativePath}/`] = { bytes: 0, sha256: digest(Buffer.alloc(0)) }
        else await visit(path, relativePath)
      } else if (entry.isFile()) {
        const bytes = await readFile(path)
        result[relativePath] = { bytes: bytes.length, sha256: digest(bytes) }
        stats.targetHashBytes += bytes.length
        stats.targetHashFiles++
      }
    }
  }
  await visit(root, '')
  return result
}

async function validateTargetLogs(session, stats, blockers) {
  const entries = await readdir(session.path, { withFileTypes: true })
  for (const entry of entries.filter((item) => item.isFile() && SESSION_FILE_RE.test(item.name))) {
    const path = join(session.path, entry.name)
    try {
      const lines = await readLogLines(path, stats)
      if (lines.length === 0 || lines[0].type !== 'session' || lines[0].id !== session.id) {
        throw new Error('session generation header does not match selected session')
      }
      for (const item of lines) {
        if (
          !item ||
          typeof item !== 'object' ||
          Array.isArray(item) ||
          typeof item.type !== 'string'
        ) {
          throw new Error('JSONL row is not a typed object')
        }
        collectLogReferences(item, session.lineageRefs, session.id)
      }
    } catch (error) {
      blockers.push({
        code: 'selected-session-log-invalid',
        id: session.id,
        path,
        detail: String(error),
      })
      session.blockers.push('selected-session-log-invalid')
    }
  }
}

function collectLogReferences(value, refs, sessionId) {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) collectLogReferences(item, refs, sessionId)
    return
  }
  if (typeof value.parentSession === 'string' && value.parentSession !== sessionId)
    refs.push(value.parentSession)
  if (typeof value.origin?.sessionId === 'string' && value.origin.sessionId !== sessionId)
    refs.push(value.origin.sessionId)
  for (const item of Object.values(value))
    if (item && typeof item === 'object') collectLogReferences(item, refs, sessionId)
}

async function readLogLines(path, stats) {
  const compressed = path.endsWith('.zstd')
  const bytes = await readFile(path)
  stats.fullLogBytesRead += bytes.length
  const content = compressed ? await decompressZstdFrames(bytes) : bytes
  const rows = []
  for (const line of content.toString('utf8').split(/\r?\n/)) {
    if (line.trim() === '') continue
    rows.push(JSON.parse(line))
  }
  return rows
}

async function readHeader(path, full, stats) {
  if (!path.endsWith('.zstd')) {
    const bytes = full ? await readFile(path) : await readPrefix(path, MAX_HEADER_BYTES)
    stats.headerBytesRead += bytes.length
    const line = firstLine(bytes)
    if (line === undefined) throw new Error('session header is empty')
    return JSON.parse(line)
  }
  if (full) {
    const bytes = await readFile(path)
    stats.fullLogBytesRead += bytes.length
    const text = await decompressZstdFrames(bytes)
    const line = firstLine(text)
    if (line === undefined) throw new Error('session header is empty')
    return JSON.parse(line)
  }
  const chunks = []
  let size = 0
  await new Promise((resolvePromise, reject) => {
    const source = createReadStream(path)
    const decoder = createZstdDecompress()
    let foundNewline = false
    const finish = () => {
      source.destroy()
      decoder.destroy()
      resolvePromise()
    }
    decoder.on('data', (chunk) => {
      chunks.push(chunk)
      size += chunk.length
      if (size > MAX_HEADER_BYTES) finish()
      else if (!foundNewline && chunk.includes(10)) {
        foundNewline = true
        finish()
      }
    })
    decoder.on('error', reject)
    decoder.on('end', resolvePromise)
    source.on('error', reject)
    source.pipe(decoder)
  })
  const bytes = Buffer.concat(chunks)
  stats.headerBytesRead += bytes.length
  const line = firstLine(bytes)
  if (line === undefined) throw new Error('session header is empty')
  return JSON.parse(line)
}

async function readPrefix(path, limit) {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(limit)
    const { bytesRead } = await handle.read(buffer, 0, limit, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

function firstLine(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
  const end = bytes.indexOf(10)
  const line = (end === -1 ? bytes : bytes.subarray(0, end)).toString('utf8').replace(/\r$/, '')
  return line.trim() ? line : undefined
}

async function decompressZstdFrames(bytes) {
  const outputs = []
  let offset = 0
  while (offset < bytes.length) {
    const frame = bytes.subarray(offset)
    const result = await new Promise((resolvePromise, reject) => {
      const decoder = createZstdDecompress()
      const chunks = []
      decoder.on('data', (chunk) => chunks.push(chunk))
      decoder.once('error', reject)
      decoder.once('end', () =>
        resolvePromise({ bytes: Buffer.concat(chunks), consumed: decoder.bytesWritten }),
      )
      decoder.end(frame)
    })
    if (!result.consumed || result.consumed > frame.length)
      throw new Error('invalid concatenated zstd frame')
    outputs.push(result.bytes)
    offset += result.consumed
  }
  return Buffer.concat(outputs)
}

async function knownIndexPaths(root) {
  const paths = [await safeChild(root, 'storages', 'workspace.json')]
  const profileRoot = await safeChild(root, 'profiles', 'desktop')
  for (const name of INDEX_NAMES) {
    const candidate = join(profileRoot, name)
    try {
      const item = await lstat(candidate)
      if (item.isSymbolicLink())
        throw new Error(`symbolic link or reparse point is not allowed: ${candidate}`)
      if (item.isFile()) paths.push(candidate)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  const taskFeedback = await safeChild(root, 'storages', 'task_feedback.json')
  try {
    const item = await lstat(taskFeedback)
    if (item.isSymbolicLink())
      throw new Error(`symbolic link or reparse point is not allowed: ${taskFeedback}`)
    if (item.isFile()) paths.push(taskFeedback)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  for (const name of KNOWN_EDIT_DIRECTORIES) {
    const directory = await safeChild(root, 'profiles', 'desktop', name)
    for (const entry of await readOptionalDirectory(directory, [], 'edit-directory-unreadable')) {
      await ensureSafeEntry(directory, entry, [])
      if (entry.isFile() && entry.name.endsWith('.json')) paths.push(join(directory, entry.name))
    }
  }
  for (const candidate of [
    await safeChild(root, 'storages', 'session_index.jsonl'),
    await safeChild(root, 'session_index.jsonl'),
  ]) {
    try {
      const item = await lstat(candidate)
      if (item.isSymbolicLink())
        throw new Error(`symbolic link or reparse point is not allowed: ${candidate}`)
      if (item.isFile()) paths.push(candidate)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  return paths
}

function isSafeId(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    value !== '.' &&
    value !== '..'
  )
}
