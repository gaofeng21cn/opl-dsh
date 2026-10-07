import { test, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error Installer is shipped as JavaScript without TypeScript declarations.
import { installSkill } from '../../installer/skill-install.mjs'

test('an upgraded Skill keeps its backup outside active skill discovery and preserves its ledger', () => {
  const base = mkdtempSync(join(tmpdir(), 'opl-skill-backup-'))
  try {
    const release = join(base, 'release')
    const codexHome = join(base, 'codex')
    mkdirSync(join(release, 'skill'), { recursive: true })
    for (const file of ['SKILL.md', 'control.mjs', 'harness-mcp.mjs', 'windows-acl.mjs']) {
      writeFileSync(join(release, 'skill', file), 'original\n')
    }
    const options = {
      release,
      codexHome,
      executable: join(base, 'app'),
      home: join(base, 'profile'),
      launcher: join(base, 'launcher'),
      root: join(base, 'suite'),
    }
    const dir = installSkill(options)
    const config = readFileSync(join(dir, 'config.json'), 'utf8')
    writeFileSync(join(release, 'skill/SKILL.md'), 'updated\n')
    installSkill(options)
    expect(readdirSync(join(codexHome, 'skills'))).toEqual(['opl-dsh-official'])
    const backups = readdirSync(join(codexHome, 'skill-backups'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(codexHome, 'skill-backups', backups[0]!, 'SKILL.md'), 'utf8')).toBe(
      'original\n',
    )
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toBe('updated\n')
    expect(readFileSync(join(dir, 'config.json'), 'utf8')).toBe(config)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
