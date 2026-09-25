import { openLoginPage, focusApplication } from './desktop-platform.mjs'
/** Open OPL's own settings before the official native first-run credential gate. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
const [home,appPid,launcher,application]=process.argv.slice(2)
let binding
for(let n=0;n<120;n++) {
  try { binding=JSON.parse(await readFile(join(home,'profiles/desktop/control.json'),'utf8'));process.kill(binding.pid,0);break } catch { await new Promise(resolve=>setTimeout(resolve,500)) }
}
if(!binding) throw new Error('官方桌面未能启动，请检查套件目录 desktop.log')
async function rpc(namespace,method,args={}) {
  const response=await fetch(binding.endpoint,{method:'POST',headers:{authorization:'Bearer '+binding.token,'content-type':'application/json'},body:JSON.stringify({namespace,method,args}),signal:AbortSignal.timeout(15000)})
  const result=await response.json();if(!result.ok)throw new Error(result.error);return result.value
}
const ready = (setup, gateway) => setup.choice === 'later' || (setup.choice === 'official' ? Boolean(setup.officialProvider) : gateway.keyReady && gateway.codexKeyReady)
let setup = await rpc('oplSuite','setupStatus')
let gateway = await rpc('oplGatewayAccount','status')
if (!ready(setup, gateway)) {
  const url = await rpc('oplSuite','setupUrl')
  openLoginPage(url)
  console.log('请在打开的页面选择 DeepSeek 官方或 OPL Gateway，并完成登录。')
  let focusedOfficial = false
  for (let n=0; n<600; n++) {
    await new Promise(resolve=>setTimeout(resolve,1000))
    setup = await rpc('oplSuite','setupStatus')
    gateway = await rpc('oplGatewayAccount','status')
    if (setup.choice === 'official' && !focusedOfficial) {
      focusApplication(application)
      focusedOfficial = true
    }
    if (setup.choice !== 'official') focusedOfficial = false
    if (ready(setup,gateway)) break
  }
  if (!ready(setup,gateway)) throw new Error('登录尚未完成。可稍后退出应用并重新运行安装器，已有配置会保留。')
  if (setup.choice === 'later') {
    focusApplication(application)
    console.log('安装完成，可在官方欢迎窗口选择稍后设置。')
    process.exit(0)
  }
  await rpc('oplSuite','finishSetup')
  process.kill(Number(appPid),'SIGTERM')
  for (let n=0;n<60;n++) {
    try { process.kill(Number(appPid),0) } catch { break }
    await new Promise(resolve=>setTimeout(resolve,500))
  }
  const env={...process.env}; delete env.ELECTRON_RUN_AS_NODE
  const child=spawn(launcher,[],{env,detached:true,stdio:'ignore'}); child.unref()
  console.log('账户已配置，正在打开官方桌面。')
} else console.log(setup.choice === 'later' ? '安装完成，可稍后登录。' : '账户连接已就绪。')
