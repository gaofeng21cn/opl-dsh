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
run(executable,[join(release,'profile.cjs'),app,home,join(release,artifact.name)],{ELECTRON_RUN_AS_NODE:'1'})
const launcher=process.env.OPL_DESKTOP_LAUNCHER ?? join(root,'launch.command')
if (!process.env.OPL_DESKTOP_LAUNCHER) {
const launch=`#!/bin/bash\nset -euo pipefail\nunset ELECTRON_RUN_AS_NODE\nexport NODE_USE_SYSTEM_CA=1\nexport DSH_HOME=${quote(home)}\nexec ${quote(executable)} --user-data-dir=${quote(join(root,'electron'))} >>${quote(join(root,'desktop.log'))} 2>&1\n`
writeFileSync(launcher,launch,{mode:0o700})
const shortcut=join(dirname(app),'OPL DSH.command')
const shortcutBody=`#!/bin/bash\nexec ${quote(launcher)}\n`
if(existsSync(shortcut) && !readFileSync(shortcut,'utf8').includes(quote(launcher))) throw new Error('已有同名 OPL DSH.command，已保留；请使用套件目录内的启动入口')
writeFileSync(shortcut,shortcutBody,{mode:0o700})
}
const codexHome=process.env.OPL_CODEX_HOME ?? process.env.CODEX_HOME ?? join(homedir(),'.codex')
const skillDir=join(codexHome,'skills/opl-dsh-official')
const skillManifest=join(skillDir,'.opl-install.json')
if(existsSync(skillDir)) {
  if(lstatSync(skillDir).isSymbolicLink() || !existsSync(skillManifest)) throw new Error('已有非本安装器管理的 opl-dsh-official Skill，已保留')
  const previous=JSON.parse(readFileSync(skillManifest,'utf8'))
  if(previous.owner!=='opl-dsh-suite' || readdirSync(skillDir).some(file=>file!=='.opl-install.json' && !Object.hasOwn(previous.files,file)) || Object.entries(previous.files).some(([file,hash])=>!existsSync(join(skillDir,file)) || digest(readFileSync(join(skillDir,file)))!==hash)) throw new Error('Codex Skill 已被手动修改，已保留；请先备份并移走该目录再更新')
}
const skillStage=skillDir+'.stage-'+process.pid
mkdirSync(skillStage,{recursive:true,mode:0o700})
cpSync(join(release,'skill'),skillStage,{recursive:true})
writeFileSync(join(skillStage,'config.json'),JSON.stringify({executable,home,launcher,ledger:join(root,'codex-ledger')},null,2)+'\n',{mode:0o600})
const files=Object.fromEntries(['SKILL.md','control.mjs','config.json'].map(file=>[file,digest(readFileSync(join(skillStage,file)))]))
writeFileSync(join(skillStage,'.opl-install.json'),JSON.stringify({owner:'opl-dsh-suite',files})+'\n',{mode:0o600})
if(existsSync(skillDir) && Object.entries(files).every(([file,hash])=>digest(readFileSync(join(skillDir,file)))===hash)) {
  rmSync(skillStage,{recursive:true})
} else {
  if(existsSync(skillDir)) renameSync(skillDir,skillDir+'.backup-'+Date.now())
  renameSync(skillStage,skillDir)
}
writeFileSync(join(root,'installation.json'),JSON.stringify({version:1,officialVersion:'0.1.7-rc.2',app,home,release,enhancementSha256:artifact.sha256,suiteSha256:artifact.suiteSha256,launcher,skillDir,installedAt:new Date().toISOString()},null,2)+'\n',{mode:0o600})
console.log('官方桌面和 OPL 增强已安装。Codex Skill：opl-dsh-official。')
if(!flags.includes('--no-launch')) {
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
  const child=spawn(launcher,[],{env,detached:true,stdio:'ignore'});child.unref()
  run(executable,[join(release,'setup.mjs'),home,String(child.pid),launcher,app],{ELECTRON_RUN_AS_NODE:'1'})
}
