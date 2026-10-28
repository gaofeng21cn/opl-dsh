import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error The installer Skill ships JavaScript without declarations.
import {
  assertDesktopStopped,
  assertSafePath,
  recycleTarget,
  safeTree,
} from '../../installer/cleanup-skill/windows-io.mjs'

const temporaryRoots: string[] = []

function createRoot() {
  const root = mkdtempSync(join(tmpdir(), 'opl-cleanup-windows-io-'))
  temporaryRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('cleanup Windows IO safety', () => {
  it('returns exact file hashes and includes empty directories in a deterministic tree', () => {
    const root = createRoot()
    mkdirSync(join(root, 'empty'))
    mkdirSync(join(root, 'nested', 'also-empty'), { recursive: true })
    writeFileSync(join(root, 'nested', 'session.jsonl'), 'session bytes')
    const emptyHash = createHash('sha256').update(Buffer.alloc(0)).digest('hex')
    const fileHash = createHash('sha256').update('session bytes').digest('hex')

    const tree = safeTree(root)

    expect(tree).toEqual({
      'empty/': { bytes: 0, sha256: emptyHash },
      'nested/also-empty/': { bytes: 0, sha256: emptyHash },
      'nested/session.jsonl': { bytes: 13, sha256: fileHash },
    })
    expect(safeTree(root)).toEqual(tree)
  })

  it('distinguishes a single file from a directory and rejects tree links', () => {
    const root = createRoot()
    const file = join(root, 'single.json')
    writeFileSync(file, '{}')

    expect(Object.keys(safeTree(file))).toEqual(['.'])
    const destination = join(root, 'destination')
    mkdirSync(destination)
    symlinkSync(
      destination,
      join(root, 'directory-link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    expect(() => safeTree(join(root, 'directory-link'))).toThrow(/符号链接/u)
    expect(() => safeTree(root)).toThrow(/符号链接/u)
  })

  it('requires a strict descendant and rejects a junction in a target parent', () => {
    const root = createRoot()
    const outside = createRoot()
    const owned = join(root, 'sessions')
    const target = join(owned, 'session-a')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'session.jsonl'), 'kept')
    symlinkSync(outside, join(root, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir')

    expect(assertSafePath(target, owned)).toBe(target)
    expect(() => assertSafePath(owned, owned)).toThrow(/安全根/u)
    expect(() => assertSafePath(join(outside, 'anything'), owned)).toThrow(/安全根/u)
    expect(() => safeTree(join(root, 'redirect'))).toThrow(/符号链接/u)
    expect(() => safeTree(join(root, 'redirect', 'session-a'))).toThrow(/符号链接/u)
  })

  it.runIf(process.platform === 'win32')(
    'matches a live Desktop executable by exact path without stopping it',
    async () => {
      await expect(assertDesktopStopped(process.execPath)).rejects.toThrow(/仍在运行/u)
      await expect(assertDesktopStopped(`${process.execPath}.missing`)).resolves.toBeUndefined()
    },
  )

  it.runIf(process.platform === 'win32')(
    'refuses a drifted target before sending anything to the Recycle Bin',
    async () => {
      const root = createRoot()
      const file = join(root, 'session.jsonl')
      writeFileSync(file, 'original')
      const wrongTree = {
        '.': {
          bytes: 7,
          sha256: createHash('sha256').update('original').digest('hex'),
        },
      }

      await expect(recycleTarget({ path: file, tree: wrongTree })).rejects.toThrow(/已变化/u)
      expect(existsSync(file)).toBe(true)
    },
  )
})
