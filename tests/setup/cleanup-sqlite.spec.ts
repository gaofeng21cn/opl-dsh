import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { readSqliteSessions } from '../../installer/cleanup-skill/sqlite-store.mjs'

let home: string
let folder: string
let dbPath: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'opl-sqlite-inspection-'))
  folder = join(home, 'sessions', '.segments')
  mkdirSync(folder, { recursive: true })
  dbPath = join(folder, 'sessions.sqlite')
  const db = new DatabaseSync(dbPath)
  try {
    db.exec(readFileSync(new URL('./fixtures/official-sqlite-v1.sql', import.meta.url), 'utf8'))
    db.exec('PRAGMA journal_mode=WAL')
  } finally {
    db.close()
  }
})
afterEach(() => rmSync(home, { recursive: true, force: true }))
it('reads an offline WAL database without creating sidecars', () => {
  expect(readSqliteSessions(home, () => {}).size).toBe(0)
  expect(readdirSync(folder)).toEqual(['sessions.sqlite'])
})
it('refuses future storage, even if the tables look familiar', () => {
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA user_version=2')
  db.close()
  expect(() => readSqliteSessions(home, () => {})).toThrow(/版本/)
})
it('leaves a foreign route untouched and blocks cleanup', () => {
  const extra = join(folder, 'ambiguous.json')
  writeFileSync(extra, '{}')
  expect(() => readSqliteSessions(home, () => {})).toThrow(/旁文件/)
  expect(readFileSync(extra, 'utf8')).toBe('{}')
})
