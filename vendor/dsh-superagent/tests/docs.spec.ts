import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entries = ['README.md']
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8')
function links(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(/\]\(([^)\s]+)\)/g)]
    .map((match) => match[1]!.split('#')[0]!)
    .filter((target) => target && !/^[a-z]+:/.test(target))
}

describe('documentation', () => {
  it('resolves every local link', () => {
    const files = entries.map((name) => join(ROOT, name))
    const missing = files.flatMap((file) =>
      links(file)
        .filter((target) => !existsSync(resolve(dirname(file), target)))
        .map((target) => `${file.slice(ROOT.length + 1)} → ${target}`),
    )
    expect(missing).toEqual([])
  })
  it('leaves no merge conflict markers in any document', () => {
    expect(entries.filter((path) => /^(<{7}|>{7}) /m.test(read(path)))).toEqual([])
  })
})
