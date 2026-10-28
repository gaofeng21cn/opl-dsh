import { test, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error Installer is shipped as JavaScript without TypeScript declarations.
import { installCleanupSkill, installSkill } from '../../installer/skill-install.mjs'

test('an upgraded Skill keeps its backup outside active skill discovery and preserves its ledger', () => {
  const base = mkdtempSync(join(tmpdir(), 'opl-skill-backup-'))
  try {
    const release = join(base, 'release')
    const codexHome = join(base, 'codex')
    mkdirSync(join(release, 'skill'), { recursive: true })
    writeFileSync(
      join(release, 'windows-lifecycle.mjs'),
      'export const launchIndependent = () => {}\n',
    )
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

test('cleanup Skill upgrades an unowned legacy copy into an installer-managed Skill', () => {
  const base = mkdtempSync(join(tmpdir(), 'opl-cleanup-skill-backup-'))
  try {
    const release = join(base, 'release')
    const cleanupSource = join(release, 'cleanup-skill')
    const codexHome = join(base, 'codex')
    const active = join(codexHome, 'skills', 'opl-dsh-session-cleanup')
    mkdirSync(join(cleanupSource, 'agents'), { recursive: true })
    mkdirSync(join(cleanupSource, 'references'), { recursive: true })
    mkdirSync(join(active, 'agents'), { recursive: true })
    mkdirSync(join(active, 'references'), { recursive: true })
    writeFileSync(join(active, 'SKILL.md'), 'legacy\n')
    writeFileSync(join(cleanupSource, 'SKILL.md'), 'current\n')
    writeFileSync(join(cleanupSource, 'cleanup.mjs'), 'export {}\n')
    writeFileSync(join(cleanupSource, 'snapshot.mjs'), 'export {}\n')
    writeFileSync(join(cleanupSource, 'windows-io.mjs'), 'export {}\n')
    writeFileSync(
      join(cleanupSource, 'agents/openai.yaml'),
      'interface:\n  display_name: current\n',
    )
    writeFileSync(join(cleanupSource, 'references/windows-recycling.md'), 'recycling\n')
    writeFileSync(join(cleanupSource, 'references/provider-contract.md'), 'provider\n')

    const installed = installCleanupSkill({ release, codexHome })
    const backups = readdirSync(join(codexHome, 'skill-backups'))

    expect(backups).toHaveLength(1)
    expect(readFileSync(join(codexHome, 'skill-backups', backups[0]!, 'SKILL.md'), 'utf8')).toBe(
      'legacy\n',
    )
    expect(readFileSync(join(installed, 'SKILL.md'), 'utf8')).toBe('current\n')
    expect(readFileSync(join(installed, '.opl-install.json'), 'utf8')).toContain('opl-dsh-suite')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('cleanup Skill can add packaged resources to an older managed copy', () => {
  const base = mkdtempSync(join(tmpdir(), 'opl-cleanup-skill-resource-upgrade-'))
  try {
    const release = join(base, 'release')
    const source = join(release, 'cleanup-skill')
    const codexHome = join(base, 'codex')
    mkdirSync(join(source, 'agents'), { recursive: true })
    mkdirSync(join(source, 'references'), { recursive: true })
    for (const [file, contents] of [
      ['SKILL.md', 'current\n'],
      ['cleanup.mjs', 'export {}\n'],
      ['snapshot.mjs', 'export {}\n'],
      ['windows-io.mjs', 'export {}\n'],
      ['agents/openai.yaml', 'interface:\n  display_name: current\n'],
      ['references/windows-recycling.md', 'recycling\n'],
      ['references/provider-contract.md', 'provider\n'],
    ])
      writeFileSync(join(source, file), contents)

    const installed = installCleanupSkill({ release, codexHome })
    const markerPath = join(installed, '.opl-install.json')
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as {
      owner: string
      files: Record<string, string>
    }
    delete marker.files['references/provider-contract.md']
    writeFileSync(markerPath, JSON.stringify(marker) + '\n')
    rmSync(join(installed, 'references/provider-contract.md'))

    installCleanupSkill({ release, codexHome })

    expect(readFileSync(join(installed, 'references/provider-contract.md'), 'utf8')).toBe(
      'provider\n',
    )
    expect(JSON.parse(readFileSync(markerPath, 'utf8')).files).toHaveProperty(
      'references/provider-contract.md',
    )
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('cleanup Skill refuses to overwrite changes to an installer-managed file', () => {
  const base = mkdtempSync(join(tmpdir(), 'opl-cleanup-skill-user-edit-'))
  try {
    const release = join(base, 'release')
    const source = join(release, 'cleanup-skill')
    const codexHome = join(base, 'codex')
    mkdirSync(join(source, 'agents'), { recursive: true })
    mkdirSync(join(source, 'references'), { recursive: true })
    for (const file of [
      'SKILL.md',
      'cleanup.mjs',
      'snapshot.mjs',
      'windows-io.mjs',
      'agents/openai.yaml',
      'references/windows-recycling.md',
      'references/provider-contract.md',
    ])
      writeFileSync(join(source, file), 'managed\n')

    const installed = installCleanupSkill({ release, codexHome })
    writeFileSync(join(installed, 'SKILL.md'), 'user change\n')

    expect(() => installCleanupSkill({ release, codexHome })).toThrow('已被手动修改')
    expect(readFileSync(join(installed, 'SKILL.md'), 'utf8')).toBe('user change\n')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
