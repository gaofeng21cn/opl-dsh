/** Open OPL's own settings before the official native first-run credential gate. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
const [home,appPid,launcher]=process.argv.slice(2)
let binding
for(let n=0;n<120;n++) {
  try { binding=JSON.parse(await readFile(join(home,'profiles/desktop/control.json'),'utf8'));process.kill(binding.pid,0);break } catch { await new Promise(resolve=>setTimeout(resolve,500)) }
}
if(!binding) throw new Error('官方桌面未能启动，请检查套件目录 desktop.log')
async function rpc(namespace,method,args={}) {
  const response=await fetch(binding.endpoint,{method:'POST',headers:{authorization:'Bearer '+binding.token,'content-type':'application/json'},body:JSON.stringify({namespace,method,args}),signal:AbortSignal.timeout(15000)})
  const result=await response.json();if(!result.ok)throw new Error(result.error);return result.value
}
const status=await rpc('oplGatewayAccount','status')
if(!status.keyReady || !status.codexKeyReady) {
  const url=await rpc('oplSuite','setupUrl')
  execFileSync('/usr/bin/open',[url])
  console.log('请在已打开的页面登录 OPL Gateway；完成后将自动进入官方桌面。')
  let ready=false
  for(let n=0;n<600;n++) {
    await new Promise(resolve=>setTimeout(resolve,1000))
    const current=await rpc('oplGatewayAccount','status')
    if(current.keyReady && current.codexKeyReady){ready=true;break}
  }
  if(!ready) throw new Error('登录尚未完成。可稍后重新运行安装器，已有配置会保留。')
  process.kill(Number(appPid),'SIGTERM')
  for(let n=0;n<60;n++) {
    try { process.kill(Number(appPid),0) } catch { break }
    await new Promise(resolve=>setTimeout(resolve,500))
  }
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
  const child=spawn(launcher,[],{env,detached:true,stdio:'ignore'});child.unref()
  console.log('Gateway 双通道配置完成，正在打开官方桌面。')
} else console.log('Gateway 双通道已就绪。')
