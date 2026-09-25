/** Small enhancement installers; the original signed desktop is downloaded by its vendor URL. */
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { rmSync, mkdirSync, cpSync, writeFileSync } from 'node:fs'
const root=import.meta.dirname,dist=join(root,'dist'),payload=join(dist,'OPL DSH 一键安装')
const zip=(source,name,keep=false)=>{
 const target=join(dist,name);rmSync(target,{force:true})
 // Python emits the standard UTF-8 ZIP flag, unlike ditto's platform-specific
 // filename encoding which Windows expands as mojibake.
 execFileSync('python3',['-c',`import pathlib, sys, zipfile
source,target,keep=sys.argv[1:]
source=pathlib.Path(source)
with zipfile.ZipFile(target,'w',compression=zipfile.ZIP_DEFLATED) as archive:
 for path in sorted(source.rglob('*')):
  if path.is_file():
   name=path.relative_to(source.parent if keep=='1' else source)
   archive.write(path,str(name))
`,source,target,keep?'1':'0'])
 console.log(target)
}
zip(payload,'OPL-DSH-Enhancements.zip')
for(const platform of ['mac-arm64','windows-x64']){
 const stage=join(dist,'setup-'+platform,'OPL DSH 安装');rmSync(stage,{force:true,recursive:true});mkdirSync(stage,{recursive:true});cpSync(payload,join(stage,'.payload'),{recursive:true})
 if(platform==='mac-arm64')writeFileSync(join(stage,'安装 OPL DSH.command'),'#!/bin/bash\nset -euo pipefail\nHERE="$(cd "$(dirname "$0")" && pwd)"\nexec /bin/bash "$HERE/.payload/install.command"\n',{mode:0o755})
 else writeFileSync(join(stage,'安装 OPL DSH.cmd'),'@echo off\r\nchcp 65001 >nul\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0.payload\\install.ps1"\r\nif errorlevel 1 pause\r\n')
 writeFileSync(join(stage,'安装说明.txt'),'OPL DSH 0.2.1\n\n解压后，双击“安装 OPL DSH”。安装器会下载并验证官方桌面、安装 OPL 增强和 Codex Skill，之后打开应用内登录引导。\n\nMac 从应用程序目录打开 OPL DSH；Windows 从开始菜单打开 OPL DSH。无需手动填写模型地址或 API Key。\n\n增强包启动时检查更新，不修改运行中的会话；官方桌面保留官方更新入口。\n\nhttps://github.com/gaofeng21cn/opl-dsh\n')
 zip(stage,`OPL-DSH-Setup-${platform}.zip`,true)
}
