import { installSkill, verifySkill } from './skill-install.mjs'
/** Install only OPL-owned files, then launch the unmodified official application. */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, mkdirSync, cpSync, writeFileSync, renameSync, rmSync, lstatSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync, spawn } from 'node:child_process'
const [app, root, payload, ...flags] = process.argv.slice(2)
const home = join(root, 'data')
const executable = process.platform === 'win32' ? join(app,'DeepSeek Harness.exe') : join(app,'Contents/MacOS/DeepSeek Harness')
const bindingPath = join(home,'profiles/desktop/control.json')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const quote = value => "'"+value.replaceAll("'", "'\\''")+"'"
function run(command,args,env={}) {
  const result=spawnSync(command,args,{stdio:'inherit',env:{...process.env,...env}})
  if(result.error) throw result.error
  if(result.status!==0) throw new Error('安装步骤失败，未启动应用')
}
function alive(pid) { try { process.kill(pid,0); return true } catch(error) { if(error.code==='ESRCH') return false; throw error } }
if(existsSync(bindingPath) && alive(JSON.parse(readFileSync(bindingPath,'utf8')).pid)) throw new Error('请先从菜单退出本套件启动的 DeepSeek Harness，再重新运行安装器。')
const artifact=JSON.parse(readFileSync(join(payload,'artifact.json'),'utf8'))
if(!/^opl-dsh-enhancements-[a-zA-Z0-9.-]+\.tgz$/.test(artifact.name)) throw new Error('安装清单无效')
const bytes=readFileSync(join(payload,artifact.name))
if(digest(bytes)!==artifact.sha256) throw new Error('增强包校验失败')
if (!artifact.payloadFiles || digest(JSON.stringify(artifact.payloadFiles)) !== artifact.suiteSha256) throw new Error('套件安装清单无效')
for (const [file, expected] of Object.entries(artifact.payloadFiles)) {
  if (file.startsWith('/') || file.split('/').some(part => !part || part === '..' || part === '.')) throw new Error('套件路径无效')
  if (digest(readFileSync(join(payload,file))) !== expected) throw new Error('套件文件校验失败：'+file)
}
const release=join(root,'releases',artifact.suiteSha256)
if (existsSync(release)) {
  for (const [file, expected] of Object.entries(artifact.payloadFiles)) {
    if (digest(readFileSync(join(release,file))) !== expected) throw new Error('已有安装文件被修改，已保留：'+file)
  }
} else {
  mkdirSync(release,{recursive:true,mode:0o700})
  cpSync(payload,release,{recursive:true})
}
const patch=join(home,'profiles/desktop/cordis.patch.yml')
mkdirSync(dirname(patch),{recursive:true,mode:0o700})
if(!existsSync(patch)) writeFileSync(patch,'- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n    compression: gzip\n    compressionLevel: 1\n    compressionThresholdBytes: 1024\n',{mode:0o600,flag:'wx'})
verifySkill(join(process.env.OPL_CODEX_HOME??process.env.CODEX_HOME??join(homedir(),'.codex'),'skills/opl-dsh-official'))
run(executable,[join(release,'migrate.cjs'),app,home,root],{ELECTRON_RUN_AS_NODE:'1'})
run(executable,[join(release,'profile.cjs'),app,home,join(release,artifact.name)],{ELECTRON_RUN_AS_NODE:'1'})
const launcher=process.env.OPL_DESKTOP_LAUNCHER ?? join(root,process.platform==='win32'?'launch.vbs':'launch.command')
if (!process.env.OPL_DESKTOP_LAUNCHER) {
if (process.platform === 'win32') {
  const quoteVbs = value => '"' + value.replaceAll('"', '""') + '"'
  const command = `"${executable}" "${join(release,'setup.mjs')}" "${home}" "${root}" "${app}"`
  writeFileSync(launcher, 'Set shell = CreateObject("WScript.Shell")\r\nshell.Environment("Process")("ELECTRON_RUN_AS_NODE") = "1"\r\nshell.Environment("Process")("NODE_USE_SYSTEM_CA") = "1"\r\nshell.Run '+quoteVbs(command)+', 0, False\r\n')
  const script = "$s = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path ([Environment]::GetFolderPath('Programs')) 'OPL DSH.lnk')); $s.TargetPath = 'wscript.exe'; $s.Arguments = [char]34 + $env:OPL_SHORTCUT_SCRIPT + [char]34; $s.IconLocation = $env:OPL_SHORTCUT_ICON; $s.Save()"
  run('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{OPL_SHORTCUT_SCRIPT:launcher,OPL_SHORTCUT_ICON:executable})
} else {
  const launch=`#!/bin/bash\nset -euo pipefail\nexport NODE_USE_SYSTEM_CA=1\nexport ELECTRON_RUN_AS_NODE=1\nexec ${quote(executable)} ${quote(join(release,'setup.mjs'))} ${quote(home)} ${quote(root)} ${quote(app)} >>${quote(join(root,'desktop.log'))} 2>&1\n`
  writeFileSync(launcher,launch,{mode:0o700})
  const shortcut=join(dirname(app),'OPL DSH.command')
  if(existsSync(shortcut) && !readFileSync(shortcut,'utf8').includes(quote(launcher))) throw new Error('已有同名 OPL DSH.command，已保留；请使用套件目录内的启动入口')
  writeFileSync(shortcut,`#!/bin/bash\nexec ${quote(launcher)}\n`,{mode:0o700})
  const shortcutApp=join(dirname(app),'OPL DSH.app')
  const marker=join(shortcutApp,'Contents/Resources/opl-launcher-owner.txt')
  if(!existsSync(shortcutApp) || (existsSync(marker)&&readFileSync(marker,'utf8')===root)) {
    const source=join(root,'shortcut.applescript')
    writeFileSync(source,'on run\n  do shell script '+JSON.stringify(quote(launcher)+" >/dev/null 2>&1 &")+'\nend run\n')
    run('/usr/bin/osacompile',['-o',shortcutApp,source])
    writeFileSync(marker,root)
  }
}
}
const skillDir=installSkill({executable,home,launcher,root,release})
writeFileSync(join(root,'installation.json'),JSON.stringify({version:1,suiteVersion:artifact.version,officialVersion:JSON.parse(readFileSync(join(app,process.platform==='win32'?'resources':'Contents/Resources','app.asar/package.json'),'utf8')).version,app,home,release,enhancementSha256:artifact.sha256,suiteSha256:artifact.suiteSha256,launcher,skillDir,installedAt:new Date().toISOString()},null,2)+'\n',{mode:0o600})
console.log('官方桌面和 OPL 增强已安装。Codex Skill：opl-dsh-official。')
if(!flags.includes('--no-launch')) {
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
  const child=spawn(process.platform==='win32'?'wscript.exe':launcher,process.platform==='win32'?[launcher]:[],{env,detached:true,stdio:'ignore'});child.unref()
}
