/** Import released legacy data once; preserve its original home and never copy its runtime profile. */
const {join,dirname} = require('node:path')
const {homedir} = require('node:os')
const fs = require('node:fs')
const {createRequire} = require('node:module')
const [application,home,root] = process.argv.slice(2)
const candidates=[process.env.OPL_LEGACY_HOME,join(root,'data'),process.platform==='win32'?join(process.env.APPDATA,'@deepseek-ai/dsh-desktop/dsh-home'):join(homedir(),'.dsh-opl')].filter(Boolean)
const legacy=candidates.find(path=>path!==home&&fs.existsSync(path)) ?? candidates[0]
const marker=join(root,'legacy-import.json')
if(fs.existsSync(marker)||!fs.existsSync(legacy)||legacy===home)process.exit(0)
const resources=process.platform==='win32'?join(application,'resources'):join(application,'Contents/Resources')
const requireRuntime=createRequire(join(resources,'app.asar/dsh/package.json'))
const yaml=requireRuntime('yaml')
const imported=[]
// Development V5 records require the retired fork codec; leave those histories
// at their source instead of copying unreadable sessions into the official app.
const sessions=join(legacy,'sessions')
const unsupported=fs.existsSync(sessions)&&fs.readdirSync(sessions,{recursive:true}).some(name=>{
 const match=String(name).match(/(?:^|[\\/])session\.v(\d+)\.jsonl(?:\.zstd)?$/)
 return match && Number(match[1])>4
})
if(unsupported)console.log('旧目录含开发版 V5 或更新格式，会话及关联存储保留在原目录，未自动导入。')
for(const name of unsupported?[]:['sessions','storages']){
 const source=join(legacy,name), target=join(home,name)
 if(!fs.existsSync(source)||fs.existsSync(target))continue
 const signature = dir => fs.readdirSync(dir,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()&&!e.name.endsWith('.lock')).map(e=>{const p=join(e.parentPath,e.name),st=fs.statSync(p);return [p,st.size,st.mtimeMs]}).sort((a,b)=>a[0].localeCompare(b[0]))
 const before=JSON.stringify(signature(source)), stage=target+'.legacy-stage-'+process.pid
 try {
  fs.cpSync(source,stage,{recursive:true,filter:path=>!path.endsWith('.lock')})
  if(before!==JSON.stringify(signature(source)))throw Error('旧版数据正在变化，请先退出旧版 OPL DSH 后重试。')
  fs.renameSync(stage,target)
 } catch(error) {fs.rmSync(stage,{recursive:true,force:true});throw error}
 imported.push(name)
}
const credentials=join(home,'.credentials.yaml'), old=join(legacy,'.credentials.yaml')
if(fs.existsSync(old)&&!fs.existsSync(credentials)){
 const value=yaml.parse(fs.readFileSync(old,'utf8'))
 const refs=Object.fromEntries(Object.entries(value.refs??{}).filter(([name])=>['OPL_GATEWAY_DEEPSEEK_API_KEY','OPL_GATEWAY_CODEX_API_KEY','DEEPSEEK_API_KEY'].includes(name)))
 const records=Object.fromEntries(Object.entries(value.records??{}).filter(([name])=>name==='llm-opl-gateway/session'||name.startsWith('deepseek-account/')))
 if(Object.keys(refs).length||Object.keys(records).length){fs.writeFileSync(credentials,yaml.stringify({version:value.version,records,refs}),{mode:0o600,flag:'wx'});imported.push('credentials')}
}
// Preferences and factual account cache only; no plugins, loader paths or old app resources.
for(const name of ['settings.yaml','opl-gateway-account.json']){
 const source=join(legacy,name),target=join(home,name)
 if(fs.existsSync(source)&&!fs.existsSync(target)){fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);imported.push(name)}
}
fs.writeFileSync(marker,JSON.stringify({source:legacy,imported,historySkipped:unsupported?'unsupported-session-format':undefined,importedAt:new Date().toISOString(),originalPreserved:true})+'\n',{mode:0o600,flag:'wx'})
console.log('已导入旧版数据，原目录完整保留。')
