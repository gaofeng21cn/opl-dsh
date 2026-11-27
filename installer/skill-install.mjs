import { createHash } from 'node:crypto'
import {
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  cpSync,
  chmodSync,
  writeFileSync,
  renameSync,
  rmSync,
  lstatSync,
  linkSync,
  mkdtempSync,
} from 'node:fs'
import { join, isAbsolute, dirname } from 'node:path'
import { homedir } from 'node:os'
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
export function installSkill({
  executable,
  home,
  profileHome = home,
  profile = 'desktop',
  launcher,
  root,
  suiteRoot = root,
  ledgerDir,
  release,
  dispatchReasoningEffort,
  preferredDelegation,
  codexHome = process.env.OPL_CODEX_HOME ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'),
}) {
  const skillDir = join(codexHome, 'skills/opl-dsh-official')
  verifySkill(skillDir)
  const previousConfig = existsSync(join(skillDir, 'config.json'))
    ? JSON.parse(readFileSync(join(skillDir, 'config.json'), 'utf8'))
    : undefined
  // Keep the existing operation ledger, even when an older repair placed it in
  // the profile directory. Moving it would lose idempotency for in-flight tasks.
  const ledger = previousConfig?.ledger ?? ledgerDir ?? join(suiteRoot, 'codex-ledger')
  if (!isAbsolute(ledger)) throw new Error('Skill 账本路径无效，已保留原配置')
  const skillStage = skillDir + '.stage-' + process.pid
  mkdirSync(skillStage, { recursive: true, mode: 0o700 })
  cpSync(join(release, 'skill'), skillStage, { recursive: true })
  const macProcess = join(skillStage, 'coordinator/macos-process')
  if (process.platform === 'darwin' && existsSync(macProcess)) chmodSync(macProcess, 0o700)
  // control.mjs imports ./windows-lifecycle.mjs; the Skill is copied out of the
  // release root, so the shared module has to travel with it.
  cpSync(join(release, 'windows-lifecycle.mjs'), join(skillStage, 'windows-lifecycle.mjs'))
  writeFileSync(
    join(skillStage, 'config.json'),
    JSON.stringify(
      {
        ...previousConfig,
        executable,
        home: profileHome,
        profile,
        launcher,
        ledger,
        autoStart: previousConfig?.autoStart ?? true,
        ...(dispatchReasoningEffort === undefined ? {} : { dispatchReasoningEffort }),
        ...(preferredDelegation === undefined ? {} : { preferredDelegation }),
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  )
  const files = Object.fromEntries(
    listSkillFiles(skillStage).map((file) => [file, digest(readFileSync(join(skillStage, file)))]),
  )
  writeFileSync(
    join(skillStage, '.opl-install.json'),
    JSON.stringify({ owner: 'opl-dsh-suite', files }) + '\n',
    { mode: 0o600 },
  )
  if (
    existsSync(skillDir) &&
    Object.entries(files).every(
      ([file, hash]) =>
        existsSync(join(skillDir, file)) && digest(readFileSync(join(skillDir, file))) === hash,
    )
  ) {
    rmSync(skillStage, { recursive: true })
    const installedMacProcess = join(skillDir, 'coordinator/macos-process')
    if (
      process.platform === 'darwin' &&
      existsSync(join(release, 'skill/coordinator/macos-process'))
    )
      chmodSync(installedMacProcess, 0o700)
  } else {
    if (existsSync(skillDir)) {
      // Backups outside skills must not be discovered as additional active Skills.
      const backups = join(codexHome, 'skill-backups')
      mkdirSync(backups, { recursive: true, mode: 0o700 })
      renameSync(skillDir, join(backups, 'opl-dsh-official-' + Date.now() + '-' + process.pid))
    }
    renameSync(skillStage, skillDir)
  }
  return skillDir
}

function listSkillFiles(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? join(prefix, entry.name) : entry.name
    return entry.isDirectory()
      ? listSkillFiles(join(directory, entry.name), relative)
      : [relative.replaceAll('\\', '/')]
  })
}

export function verifySkill(skillDir, repairSources = []) {
  const skillManifest = join(skillDir, '.opl-install.json')
  if (existsSync(skillDir)) {
    if (lstatSync(skillDir).isSymbolicLink() || !existsSync(skillManifest))
      throw new Error('已有非本安装器管理的 opl-dsh-official Skill，已保留')
    const previous = JSON.parse(readFileSync(skillManifest, 'utf8'))
    const helper = 'coordinator/macos-process'
    const target = join(skillDir, helper)
    const missingHelper =
      repairSources.length > 0 &&
      Object.hasOwn(previous.files ?? {}, helper) &&
      !lstatSync(target, { throwIfNoEntry: false }) &&
      lstatSync(dirname(target), { throwIfNoEntry: false })?.isDirectory()
    if (
      previous.owner !== 'opl-dsh-suite' ||
      listSkillFiles(skillDir).some(
        (file) => file !== '.opl-install.json' && !Object.hasOwn(previous.files, file),
      ) ||
      Object.entries(previous.files).some(
        ([file, hash]) =>
          !(file === helper && missingHelper) &&
          (!existsSync(join(skillDir, file)) ||
            digest(readFileSync(join(skillDir, file))) !== hash),
      )
    )
      throw new Error('Codex Skill 已被手动修改，已保留；请先备份并移走该目录再更新')
    if (missingHelper) {
      for (const source of repairSources) {
        const candidate = join(source, 'skill', helper)
        if (!lstatSync(candidate, { throwIfNoEntry: false })?.isFile()) continue
        const bytes = readFileSync(candidate)
        if (digest(bytes) !== previous.files[helper]) continue
        const temp = mkdtempSync(join(dirname(target), '.opl-helper-'))
        try {
          const staged = join(temp, 'macos-process')
          writeFileSync(staged, bytes, { mode: 0o700 })
          linkSync(staged, target)
        } finally {
          rmSync(temp, { recursive: true, force: true })
        }
        return
      }
      throw new Error('缺少 coordinator/macos-process，未找到与旧安装清单校验值相符的副本')
    }
  }
}
