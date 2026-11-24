// Support the released alpha.2 schema only. Frames and shared segments stay append-only.
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'

const digest = (value) => createHash('sha256').update(value).digest('hex')
const schema = '253cc82f123ae02312307d4abb198a14250c5fe6958f565d7e786511752f523d'
const assert = (ok, message) => {
  if (!ok) throw Error(message)
}
const file = (home) => join(home, 'sessions', '.segments', 'sessions.sqlite')
const marker = (home, id) => join(home, 'sessions', '.segments', digest(id) + '.json')
function regular(path) {
  const st = lstatSync(path)
  assert(st.isFile() && !st.isSymbolicLink() && st.nlink === 1, 'SQLite 文件链接或类型未知')
}
function open(home, write) {
  const path = file(home)
  for (const dir of [home, join(home, 'sessions'), join(home, 'sessions', '.segments')])
    assert(
      lstatSync(dir).isDirectory() && !lstatSync(dir).isSymbolicLink(),
      'SQLite 存储路径已变化',
    )
  for (const suffix of ['', '-wal', '-shm'])
    if (!suffix || existsSync(path + suffix)) regular(path + suffix)
  // SQLite can create WAL sidecars even on a read-only connection. An offline database
  // without pending WAL frames needs no shared-memory index.
  const wal = lstatSync(path + '-wal', { throwIfNoEntry: false })
  if (!write && wal?.size && !existsSync(path + '-shm'))
    throw Error('SQLite 写入日志尚未建立共享索引，请让官方程序正常退出后再试')
  const db = new DatabaseSync(
    !write && !wal?.size ? pathToFileURL(path).href + '?immutable=1' : path,
    { readOnly: !write },
  )
  try {
    db.exec(
      'PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0; ' +
        (write ? 'BEGIN IMMEDIATE' : 'BEGIN'),
    )
    assert(
      db.prepare('pragma application_id').get().application_id === 0x44535043 &&
        db.prepare('pragma user_version').get().user_version === 1,
      '未知 SQLite 标识或版本',
    )
    const ddl = db
      .prepare('select sql from sqlite_schema where sql is not null order by name')
      .all()
      .map((r) => r.sql.split(String.fromCharCode(13)).join(''))
      .join('\n')
    assert(digest(ddl) === schema, 'SQLite 表或触发器已变化')
    return db
  } catch (e) {
    db.close()
    throw e
  }
}
const allRows = (db) => db.prepare('select * from traces order by trace_uuid').all()
function history(db, row, onEvent) {
  const visited = new Set(),
    chain = []
  let id = row.tail_segment_uuid,
    limit = Infinity,
    childBase
  while (id !== null) {
    assert(!visited.has(id), 'SQLite 分支循环引用')
    visited.add(id)
    const s = db.prepare('select * from segments where segment_uuid=?').get(id)
    assert(
      s && (childBase === undefined || s.base_seq + limit === childBase),
      'SQLite 分支范围无效',
    )
    chain.push({ id, limit, base: s.base_seq })
    childBase = s.base_seq
    limit = s.parent_end_seq
    id = s.parent_segment_uuid
  }
  const hash = createHash('sha256')
  for (const seg of chain.reverse()) {
    let next = 0
    for (const f of db
      .prepare('select * from frames where segment_uuid=? order by start_seq')
      .iterate(seg.id)) {
      if (next >= seg.limit) break
      assert(f.start_seq === next, 'SQLite 历史不连续')
      const bytes = Buffer.from(f.payload)
      const lines = (f.codec === 0 ? bytes : zstdDecompressSync(bytes)).toString('utf8').split('\n')
      assert(lines.length === f.end_seq - f.start_seq, 'SQLite 帧长度不符')
      for (const line of lines.slice(0, seg.limit - next)) {
        const event = JSON.parse(line)
        assert(
          event.seq === seg.base + next && typeof event.type === 'string',
          'SQLite 事件序号无效',
        )
        next++
        hash.update(line + '\n')
        onEvent?.(event)
      }
    }
    assert(!Number.isFinite(seg.limit) || next === seg.limit, 'SQLite 分支历史缺失')
  }
  return hash.digest('hex')
}
export function readSqliteSessions(home, observe) {
  const db = open(home, false)
  try {
    const rows = allRows(db),
      files = new Set(['sessions.sqlite', 'sessions.sqlite-shm', 'sessions.sqlite-wal'])
    const result = new Map()
    for (const row of rows) {
      const h = JSON.parse(row.header),
        id = row.trace_uuid
      assert(
        h.id === id &&
          h.version === 4 &&
          typeof h.isSeeded === 'boolean' &&
          /^[a-zA-Z0-9_.-]+$/.test(id) &&
          !id.includes('..'),
        'SQLite 会话身份无效',
      )
      const m = marker(home, id)
      regular(m)
      const raw = readFileSync(m),
        r = JSON.parse(raw)
      assert(r.id === id && resolve(r.database) === resolve(file(home)), 'SQLite 路由不匹配')
      files.add(digest(id) + '.json')
      const refs = [],
        record = { row: { ...row }, route: raw.toString('base64'), header: h, refs }
      record.history = history(db, row, (event) => {
        if (event.type === 'session/title' && typeof event.data?.title === 'string')
          record.title = event.data.title
        observe(event, refs, id)
      })
      result.set(id, record)
    }
    const lockRoot = file(home) + '.session-locks'
    if (existsSync(lockRoot)) {
      const st = lstatSync(lockRoot)
      assert(st.isDirectory() && !st.isSymbolicLink(), 'SQLite 共享锁目录无效')
      for (const entry of readdirSync(lockRoot, { withFileTypes: true })) {
        assert(
          entry.isDirectory() && /^[0-9a-f]{64}$/.test(entry.name),
          'SQLite 共享锁目录含未知项目',
        )
        const dir = join(lockRoot, entry.name)
        for (const name of readdirSync(dir)) {
          assert(name === 'session.lock', 'SQLite 共享锁目录含未知旁文件')
          const path = join(dir, name)
          regular(path)
          assert(lstatSync(path).size === 0, 'SQLite 会话锁格式未知')
        }
      }
      files.add('sessions.sqlite.session-locks')
    }
    for (const name of readdirSync(join(home, 'sessions', '.segments')))
      assert(files.has(name), 'SQLite 存储含未知旁文件')
    return result
  } finally {
    db.close()
  }
}
// An immediate transaction serializes trace changes. Its journal is the frozen cleanup plan;
// a filesystem step can be resumed whether the SQLite commit succeeded or rolled back.
export function sqliteOperation(plan, action) {
  if (!plan.sqlite) return
  const write = action === 'restore' || action === 'recycle'
  const db = open(plan.home, write),
    entries = plan.sqlite
  try {
    if (!['restore', 'check-restore', 'verify-restored'].includes(action)) {
      const expected = new Map(plan.sqliteProtected.map((s) => [s.id, s]))
      for (const row of allRows(db)) {
        if (plan.targetSessionIds.includes(row.trace_uuid)) continue
        const frozen = expected.get(row.trace_uuid)
        assert(
          frozen && history(db, row) === frozen.history && digest(row.header) === frozen.header,
          '受保护的 SQLite 会话已变化',
        )
        expected.delete(row.trace_uuid)
      }
      assert(expected.size === 0, '受保护的 SQLite 会话缺失')
    }
    for (const e of entries) {
      const row = e.row,
        id = row.trace_uuid
      assert(plan.targetSessionIds.includes(id), 'SQLite 清单范围不符')
      const current = db.prepare('select * from traces where trace_uuid=?').get(id)
      if (current)
        assert(
          Object.keys(row).every((k) => row[k] === current[k]),
          'SQLite 会话已被替换',
        )
      assert(history(db, row) === e.history, 'SQLite 会话历史已变化')
      const path = marker(plan.home, id)
      const bytes = Buffer.from(e.route, 'base64')
      if (existsSync(path)) {
        regular(path)
        assert(readFileSync(path).equals(bytes), 'SQLite 路由已变化')
      }
      if (action === 'verify') {
        assert(!current && !existsSync(path), 'SQLite 会话仍可见')
        continue
      }
      if (action === 'verify-restored') {
        assert(current && existsSync(path), 'SQLite 会话恢复未完成')
        continue
      }
      if (!write) continue
      if (action === 'restore') {
        if (!current)
          db.prepare(
            'insert into traces(trace_uuid,header,tail_segment_uuid,inherited_count) values(?,?,?,?)',
          ).run(id, row.header, row.tail_segment_uuid, row.inherited_count)
      } else if (current) db.prepare('delete from traces where trace_uuid=?').run(id)
    }
    db.exec('COMMIT')
    if (!write) return
    for (const e of entries) {
      const path = marker(plan.home, e.row.trace_uuid)
      if (action === 'restore') {
        if (!existsSync(path))
          writeFileSync(path, Buffer.from(e.route, 'base64'), {
            flag: 'wx',
            mode: 0o600,
            flush: true,
          })
      } else if (existsSync(path)) {
        regular(path)
        assert(readFileSync(path).equals(Buffer.from(e.route, 'base64')), 'SQLite 路由已变化')
        unlinkSync(path)
      }
    }
  } finally {
    db.close()
  }
}

// Windows DSH leases are named semaphores, not files. Closing stdin releases the helper's handles.
export function sqliteLockTargets(plan) {
  return [
    ...plan.targets,
    ...plan.sqlite.map((e) => ({
      kind: 'session',
      id: e.row.trace_uuid,
      path: join(file(plan.home) + '.session-locks', digest(e.row.trace_uuid)),
    })),
  ]
}
export async function acquireSqliteWindowsLocks(targets) {
  const { spawn } = await import('node:child_process')
  const names = targets
    .filter((t) => t.kind === 'session')
    .map((t) => 'Local\\dsh-session-lock-' + digest(resolve(t.path, 'session.lock').toLowerCase()))
  const script = `
$ErrorActionPreference = 'Stop'
$held = @()
try {
  foreach ($name in ([Console]::ReadLine() | ConvertFrom-Json)) {
    $s = [System.Threading.Semaphore]::new(1,1,[string]$name)
    if (-not $s.WaitOne(0)) { $s.Dispose(); throw 'busy' }
    $held += $s
  }
  [Console]::WriteLine('READY')
  [Console]::ReadLine() | Out-Null
} finally { foreach($s in $held) { [void]$s.Release(); $s.Dispose() } }
`
  const proc = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true },
  )
  proc.stdin.on('error', () => {})
  const exited = new Promise((resolve) => {
    proc.once('exit', resolve)
    proc.once('error', resolve)
  })
  const ready = new Promise((resolve) =>
    proc.stdout.once('data', (data) => resolve(data.toString().trim() === 'READY')),
  )
  let timer
  try {
    proc.stdin.write(JSON.stringify(names) + '\n')
    if (
      (await Promise.race([
        ready,
        exited.then(() => false),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), 12000)
        }),
      ])) !== true
    )
      throw Error('SQLite 会话写锁仍被占用或无法核验')
    return async () => {
      proc.stdin.end()
      await exited
    }
  } catch (e) {
    proc.stdin.end()
    proc.kill()
    throw e
  } finally {
    clearTimeout(timer)
  }
}
