/** Owns mappings and transport only; each official Harness owns its agent loop. */
import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, readFile, writeFile, rename, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startControlBridge } from './control-bridge.ts'
import { homedir } from 'node:os'
import { EventEmitter } from 'node:events'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-user-questions'
import { GROK_API_KEY_REF } from '../gateway/config.ts'
import { OPL_GATEWAY_INFERENCE_BASE_URL } from '../gateway/opl-credentials.ts'
import { AcpProcess, object } from './acp.ts'
import { waitForSession } from './wait.ts'
import { DSH_COMBINATION, GROK_COMBINATION, type HarnessApproval, type HarnessCatalog, type HarnessOrigin, type HarnessSession, type HarnessSnapshot, type HarnessTurn } from './harness-types.ts'
import { catalogView, ExecutionCatalogStore, type ExecutionCatalog } from './catalog.ts'
export { GROK_COMBINATION, DSH_COMBINATION } from './harness-types.ts'
export const HARNESS_NAMESPACE = 'harness'
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const now = () => new Date().toISOString()
const required = (value: unknown, label: string): string => { if (typeof value !== 'string' || !value.trim() || value.length > 200000) throw Error(`无效的 ${label}`); return value }
export interface HarnessStartRequest { combination: string; cwd: string; existingSessionId?: string; taskId?: string; origin?: HarnessOrigin; sandbox?: 'read-only' | 'workspace' }
export interface HarnessPromptRequest { sessionId: string; text: string; operationId: string }
interface Active { acp?: AcpProcess; turn: HarnessTurn | undefined; done: Promise<void> | undefined; cancelled: boolean; bridgeStop?: (()=>Promise<void>) | undefined; approvals: Map<string, HarnessApproval & { rpcId: string | number }> }

/** GROK_CONFIG drops the model table. Use the documented independent GROK_HOME. */
export function grokConfiguration(): string {
  return `[cli]\nauto_update = false\n[models]\ndefault = "grok-4.7"\nweb_search = "grok-4.7"\n[model."grok-4.7"]\nmodel = "grok-4.7"\nname = "Grok 4.7"\nbase_url = "${OPL_GATEWAY_INFERENCE_BASE_URL}"\nenv_key = "${GROK_API_KEY_REF}"\napi_backend = "responses"\ncontext_window = 500000\nsupports_reasoning_effort = true\n[shell_environment_policy]\nexclude = ["OPL_GATEWAY_*", "DSH_*", "GROK_CONFIG*"]\n[compat.claude]\nskills = false\nrules = false\nmcps = false\nhooks = false\nsessions = false\n[compat.cursor]\nskills = false\nrules = false\nmcps = false\nhooks = false\n`;
}

function launchEnvironment(home: string, key: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of ['PATH','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','SYSTEMROOT','TEMP','TMP','TMPDIR','LANG','LC_ALL','TERM','SHELL','USER','LOGNAME','HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','NO_PROXY','https_proxy','http_proxy','all_proxy','no_proxy','SSL_CERT_FILE','SSL_CERT_DIR','NODE_EXTRA_CA_CERTS']) if (process.env[name]) env[name] = process.env[name]
  return { ...env, GROK_HOME: home, [GROK_API_KEY_REF]: key, GROK_DEFAULT_SELECTED_PERMISSION: 'allow_once' }
}
export class HarnessService {
  private readonly records = new Map<string, HarnessSession>()
  private readonly active = new Map<string, Active>()
  private readonly starting = new Map<string, Promise<HarnessSnapshot>>()
  private readonly connecting = new Map<string, Promise<void>>()
  private readonly events = new EventEmitter()
  private writeQueue: Promise<void> = Promise.resolve()
  private readonly ready: Promise<void>
  private disposed = false
  readonly directory: string
  private readonly filename: string
  private readonly catalogStore: ExecutionCatalogStore
  constructor(private readonly ctx: Context, private readonly options: { home?: string; command?: string; prefix?: string[]; resolveKey?: () => Promise<string | undefined> } = {}) {
    this.directory = options.home ?? dshHomePath()
    this.filename = join(this.directory, 'profiles/desktop/harness-sessions.json')
    this.catalogStore = new ExecutionCatalogStore(this.directory)
    this.events.setMaxListeners(100)
    this.ready = this.load()
  }
  private async load() {
    let data: unknown
    try { data = JSON.parse(await readFile(this.filename, 'utf8')) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw Error('组合会话记录无法读取，原文件已保留') }
    if (!Array.isArray(data)) throw Error('组合会话记录格式无效，原文件已保留')
    for (const raw of data) {
      const item = object(raw)
      if (typeof item.id !== 'string' || ![GROK_COMBINATION,DSH_COMBINATION].includes(item.combination) || typeof item.cwd !== 'string' || typeof item.acpSessionId !== 'string') throw Error('组合会话记录损坏，原文件已保留')
      const record: HarnessSession = { ...item, origin: item.origin ?? {kind:'desktop',sessionId:'legacy'}, sandbox: item.sandbox ?? 'read-only', title: item.title ?? 'Grok 4.7', turns: item.turns ?? [] } as HarnessSession
      for (const turn of record.turns) if (['running','waiting_approval','waiting_input'].includes(turn.state)) { turn.state = 'interrupted'; turn.error = 'Host 已重启；原轮次不会自动重发，可用新的 operation 继续原生会话' }
      this.records.set(record.id, record)
    }
  }
  private save(): Promise<void> {
    const bytes = JSON.stringify([...this.records.values()], null, 2) + '\n'
    const next = this.writeQueue.then(async () => { await mkdir(dirname(this.filename), {recursive:true,mode:0o700}); const temp = this.filename + '.' + randomUUID(); await writeFile(temp,bytes,{mode:0o600}); await rename(temp,this.filename) })
    this.writeQueue = next.catch(() => {})
    return next
  }
  private changed(record: HarnessSession) { record.updatedAt=now(); this.events.emit(record.id) }
  private async key() { return this.options.resolveKey ? this.options.resolveKey() : (await this.ctx.credentials.resolve(credentialRef(GROK_API_KEY_REF)))?.value }
  private command() { return this.options.command ?? process.env.OPL_GROK_COMMAND?.trim() ?? join(homedir(),'.grok/bin/grok') }
  async list(): Promise<HarnessCatalog> {
    await this.ready
    const catalog = await this.catalogStore.get()
    const cli = await access(this.command(),constants.X_OK).then(()=>true,()=>false)
    const key = !!(await this.key())
    const account = await this.ctx.get('oplGatewayAccount')?.status()
    const availability = new Map<string, { available: boolean; reason?: string }>([
      [DSH_COMBINATION, { available: account?.keyReady === true, ...(account?.keyReady === true ? {} : { reason: '请先配置 DeepSeek 连接' }) }],
      [GROK_COMBINATION, { available: cli && key, ...(!cli ? { reason: '未找到官方 Grok Build CLI' } : !key ? { reason: '请登录或刷新 OPL Gateway，准备 Grok 分组密钥' } : {}) }],
    ])
    return { combinations: catalogView(catalog, availability), sessions: [...this.records.values()].map(r=>this.view(r)).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)) }
  }
  async executionCatalog(): Promise<ExecutionCatalog> { await this.ready; return this.catalogStore.get() }
  async saveExecutionCatalog(value: unknown): Promise<ExecutionCatalog> { await this.ready; const catalog = await this.catalogStore.set(value); this.events.emit('catalog'); return catalog }
  private view(record: HarnessSession): HarnessSnapshot {
    const active=this.active.get(record.id)
    return structuredClone({...record,connected:record.combination===DSH_COMBINATION?!!this.ctx.agents?.get(brandString<SessionId>(record.acpSessionId)):!!active?.acp&&!active.acp.closed,state:record.turns.at(-1)?.state??'idle',approvals:[...(active?.approvals.values()??[])].map(({rpcId:_,...a})=>a)})
  }
  async snapshot(input: {sessionId:string}): Promise<HarnessSnapshot> {
    await this.ready
    const record=this.records.get(required(input?.sessionId,'sessionId')); if(!record)throw Error('执行组合会话不存在')
    return this.view(record)
  }
  async start(input: HarnessStartRequest): Promise<HarnessSnapshot> {
    await this.ready
    if(this.disposed)throw Error('组合服务已关闭')
    const catalog = await this.catalogStore.get()
    const definition = catalog.combinations.find(x => x.id === input?.combination && x.enabled)
    if(!definition)throw Error('未知或已停用的模型 + Harness 组合')
    if(![GROK_COMBINATION,DSH_COMBINATION].includes(definition.id))throw Error('该组合已保存，但尚未安装对应 Harness 适配器')
    const supplied=required(input.cwd,'cwd');if(!isAbsolute(supplied)||supplied.includes('\0'))throw Error('工作目录必须为绝对路径')
    const cwd=await realpath(supplied);if(!(await stat(cwd)).isDirectory())throw Error('工作目录不存在')
    const origin=input.origin??{kind:'desktop',sessionId:'manual'}
    if(!['codex','dsh','harness','desktop'].includes(origin.kind))throw Error('无效的来源')
    required(origin.sessionId,'origin.sessionId')
    const parent=this.parentOf(origin)
    if(origin.kind==='harness'&&!parent)throw Error('来源组合会话不存在')
    if(parent&&(parent.cwd!==cwd||input.sandbox&&input.sandbox!==parent.sandbox))throw Error('子对话必须继承原项目和权限边界')
    let ancestor=parent,depth=0
    while(ancestor){if(++depth>=4)throw Error('协作嵌套已达上限');ancestor=this.parentOf(ancestor.origin)}
    const id=input.existingSessionId??`harness-${hash([origin,input.taskId??randomUUID(),cwd,input.combination]).slice(0,24)}`
    const prior=this.records.get(id)
    if(input.existingSessionId&&!prior)throw Error('指定会话不存在，不会自动创建替代会话')
    if(prior&&(prior.combination!==input.combination||prior.cwd!==cwd))throw Error('会话组合或项目与原记录不一致')
    if(input.sandbox!==undefined&&!['workspace','read-only'].includes(input.sandbox))throw Error('无效的权限边界')
    if(prior&&input.sandbox&&prior.sandbox!==input.sandbox)throw Error('不能通过继续会话扩大权限')
    if(this.starting.has(id))return this.starting.get(id)!
    const record:HarnessSession=prior??{id,combination:input.combination,cwd,origin,sandbox:parent?.sandbox??input.sandbox??definition.sandbox,acpSessionId:'',title:definition.name,createdAt:now(),updatedAt:now(),turns:[]}
    // Persist the identity before creating a native session. A failed setup can
    // then resume the same mapping rather than orphaning an invisible session.
    this.records.set(id,record)
    const pending=this.save().then(()=>this.connect(record)).then(()=>this.view(record)).finally(()=>this.starting.delete(id))
    this.starting.set(id,pending);return pending
  }
  private parentOf(origin:HarnessOrigin):HarnessSession|undefined {
    return origin.kind==='harness'?this.records.get(origin.sessionId):origin.kind==='dsh'?[...this.records.values()].find(r=>r.combination===DSH_COMBINATION&&r.acpSessionId===origin.sessionId):undefined
  }
  private connect(record: HarnessSession):Promise<void> {
    if(this.disposed)return Promise.reject(Error('组合服务已关闭'))
    const pending=this.connecting.get(record.id)
    if(pending)return pending
    const connection=this.openConnection(record).finally(()=>this.connecting.delete(record.id))
    this.connecting.set(record.id,connection)
    return connection
  }
  private async openConnection(record: HarnessSession) {
    const existing=this.active.get(record.id)
    if(existing && (record.combination===DSH_COMBINATION || existing.acp&&!existing.acp.closed))return
    if(record.combination===DSH_COMBINATION) {
      const id=record.acpSessionId||`session-${record.id}`
      const isNew=!record.acpSessionId
      // The official create operation adopts an existing identity, including
      // a cold persisted session, after validating its working directory.
      const workspace=await this.ctx.workspaceRegistry.create(record.cwd)
      await this.native('create',{sessionId:id,workspaceId:workspace.id})
      record.acpSessionId=id;await this.save()
      await this.native('selectModel',{sessionId:id,provider:'opl-gateway',model:'deepseek-flash'})
      const session=this.ctx.sessions.get(brandString<SessionId>(id));if(!session)throw Error('DSH 子会话未创建')
      setSandboxMode(session,record.sandbox==='read-only'?'read-only':'workspace-write');setApprovalPolicy(session,'ask')
      if(isNew)await this.native('rename',{sessionId:id,title:'DeepSeek · DSH · 组合协作'})
      this.active.set(record.id,{cancelled:false,turn:undefined,done:undefined,approvals:new Map()});return
    }
    const key=await this.key();if(!key)throw Error('Grok 分组密钥未就绪，请在 OPL Gateway 页面刷新账号；不会回退到其他分组密钥')
    const home=join(this.directory,'harnesses','grok-build')
    await mkdir(home,{recursive:true,mode:0o700})
    const config=join(home,'config.toml'), bytes=grokConfiguration()
    const current=await readFile(config,'utf8').catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return undefined;throw e})
    if(current!==undefined&&current!==bytes)throw Error('套件的 Grok 配置已被修改，已保留，请核对后再启动')
    if(current===undefined)await writeFile(config,bytes,{mode:0o600,flag:'wx'})
    const active:Active={cancelled:false,turn:undefined,done:undefined,approvals:new Map()}
    const bindingPath=join(home,record.id+'.control.json')
    const bridgeStop=await startControlBridge({invoke:async request=>{
      const p=object(request.args)
      if(request.namespace!=='harness')throw Error('Capability does not allow this namespace')
      if(request.method==='start'){
        // A Grok child can request only a same-project DSH sibling, with its
        // own parent identity and inherited filesystem boundary.
        if(p.existingSessionId){const prior=this.records.get(p.existingSessionId);if(prior?.origin.kind!=='harness'||prior.origin.sessionId!==record.id)throw Error('会话不属于当前组合')}
        return this.start({combination:DSH_COMBINATION,cwd:record.cwd,taskId:required(p.taskId,'taskId'),origin:{kind:'harness',sessionId:record.id},sandbox:record.sandbox,...(p.existingSessionId?{existingSessionId:p.existingSessionId}:{})})
      }
      const child=this.records.get(p.sessionId)
      if(child?.origin.kind!=='harness'||child.origin.sessionId!==record.id||child.cwd!==record.cwd)throw Error('会话不属于当前组合')
      if(!['prompt','snapshot','wait','cancel'].includes(request.method))throw Error('Capability does not allow this operation')
      return this.invoke(request.method,p,request.signal)
    },stream:()=>{throw Error('Stream not supported')}},bindingPath)
    let stopped=false
    active.bridgeStop=async()=>{if(stopped)return;stopped=true;await bridgeStop()}
    const binding=JSON.parse(await readFile(bindingPath,'utf8')) as {endpoint:string;token:string}
    const mcpPath=fileURLToPath(new URL('./harness-mcp.mjs',import.meta.url))
    const servers=await access(mcpPath).then(()=>[{name:'opl-harness',command:process.execPath,args:[mcpPath],env:[{name:'ELECTRON_RUN_AS_NODE',value:'1'},{name:'OPL_HARNESS_ENDPOINT',value:binding.endpoint},{name:'OPL_HARNESS_TOKEN',value:binding.token}]}],()=>[])
    const acp=new AcpProcess(this.command(),[...(this.options.prefix??[]),'--cwd',record.cwd,'--model','grok-4.7','--sandbox',record.sandbox,'--permission-mode','default','agent','--no-leader','stdio'],record.cwd,launchEnvironment(home,key),
      value=>this.update(record,active,value), (id,value)=>this.ask(record,active,id,value),()=>{this.changed(record);void active.bridgeStop?.()})
    active.acp=acp
    try {
      const init=object(await acp.request('initialize',{protocolVersion:1,clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false},clientInfo:{name:'opl-dsh',version:'0.2.3'}}))
      if(init.protocolVersion!==1)throw Error('Grok Build 未协商 ACP v1')
      if(record.acpSessionId&&!object(init.agentCapabilities).loadSession)throw Error('此 Grok Build 不支持恢复原生会话')
      const session=object(await acp.request(record.acpSessionId?'session/load':'session/new',{...(record.acpSessionId?{sessionId:record.acpSessionId}:{}),cwd:record.cwd,mcpServers:servers}))
      if(!record.acpSessionId){record.acpSessionId=required(session.sessionId,'ACP sessionId');await this.save()}
      const model=object(session.models).currentModelId
      if(model!==undefined&&model!=='grok-4.7')throw Error('Grok Build 返回了不同的模型，已停止')
      this.active.set(record.id,active)
    } catch(e) { await acp.dispose();await active.bridgeStop?.();throw e }
  }
  private update(record:HarnessSession,active:Active,value:unknown) {
    const envelope=object(value);if(envelope.sessionId!==record.acpSessionId||!active.turn)return
    const u=object(envelope.update),turn=active.turn
    if(u.sessionUpdate==='agent_message_chunk'&&object(u.content).type==='text'&&typeof u.content.text==='string')turn.text+=u.content.text
    if(['tool_call','tool_call_update'].includes(u.sessionUpdate)&&typeof u.toolCallId==='string') {
      let tool=turn.tools.find(t=>t.id===u.toolCallId)
      if(!tool){tool={id:u.toolCallId,title:'工具调用',status:'pending',kind:'other'};turn.tools.push(tool)}
      for(const field of ['title','status','kind'] as const)if(typeof u[field]==='string')tool[field]=u[field].slice(0,4000)
    }
    this.changed(record)
  }
  private ask(record:HarnessSession,active:Active,rpcId:string|number,value:unknown) {
    const p=object(value)
    if(p.sessionId!==record.acpSessionId||!active.turn||active.cancelled){active.acp?.answer(rpcId);return}
    const options=(Array.isArray(p.options)?p.options:[]).map(object).filter(x=>typeof x.optionId==='string'&&typeof x.name==='string'&&['allow_once','reject_once'].includes(x.kind)).map(x=>({optionId:x.optionId as string,name:x.name as string,kind:x.kind as string}))
    const id=randomUUID()
    active.approvals.set(id,{id,rpcId,title:String(object(p.toolCall).title??'Grok 工具权限请求').slice(0,4000),options})
    active.turn.state='waiting_approval';this.changed(record);void this.save().catch(()=>this.cancel({sessionId:record.id}))
  }
  async answer(input:{sessionId:string;approvalId:string;optionId?:string}) {
    await this.ready
    const record=this.records.get(required(input.sessionId,'sessionId')),active=this.active.get(input.sessionId)
    const ask=active?.approvals.get(required(input.approvalId,'approvalId'))
    if(!record||!active||!ask)throw Error('授权请求已结束或不存在')
    if(input.optionId!==undefined&&!ask.options.some(o=>o.optionId===input.optionId))throw Error('无效的授权选项')
    active.acp?.answer(ask.rpcId,input.optionId);active.approvals.delete(ask.id)
    if(active.turn)active.turn.state=active.approvals.size?'waiting_approval':'running'
    this.changed(record);await this.save();return this.view(record)
  }
  async prompt(input:HarnessPromptRequest):Promise<HarnessSnapshot> {
    await this.ready
    if(this.disposed)throw Error('组合服务已关闭')
    const record=this.records.get(required(input?.sessionId,'sessionId'));if(!record)throw Error('组合会话不存在')
    const text=required(input.text,'text'),operation=required(input.operationId,'operationId')
    const fingerprint=hash([record.id,text])
    const previous=record.turns.find(t=>t.operationId===operation)
    if(previous){if(previous.fingerprint!==fingerprint)throw Error('同一个 operation ID 的内容发生变化');return this.view(record)}
    await this.connect(record)
    const active=this.active.get(record.id)!
    // Recheck after async connection so overlapping callers cannot race.
    const repeated=record.turns.find(t=>t.operationId===operation)
    if(repeated){if(repeated.fingerprint!==fingerprint)throw Error('同一个 operation ID 的内容发生变化');return this.view(record)}
    if(active.turn)throw Error('此会话仍在执行，请先等待或取消')
    const turn:HarnessTurn={operationId:operation,fingerprint,prompt:text,text:'',state:'running',tools:[]}
    record.turns.push(turn);record.title=text.slice(0,80);active.turn=turn;active.cancelled=false
    this.changed(record)
    try{await this.save()}catch(e){active.turn=undefined;record.turns.pop();throw e}
    active.done=this.run(record,active,turn)
    return this.view(record)
  }
  private native(method:string,request:object) {return this.ctx.typertGateway.invoke({namespace:'session',method,args:{request}})}
  private async run(record:HarnessSession,active:Active,turn:HarnessTurn) {
    try {
      if(record.combination===GROK_COMBINATION){
        const result=object(await active.acp!.request('session/prompt',{sessionId:record.acpSessionId,prompt:[{type:'text',text:turn.prompt}]},24*60*60*1000))
        turn.stopReason=String(result.stopReason??'unknown')
        turn.state=turn.stopReason==='end_turn'?'completed':turn.stopReason==='cancelled'?'cancelled':'failed'
      }else{
        const unlisten=this.ctx.on('session/event',(session,event)=>{
          if(session.id!==record.acpSessionId)return
          if(event.type==='assistant/message')turn.text+=event.data.message.content.filter(c=>c.type==='text').map(c=>c.text).join('')
          if(event.type==='approval/asked')turn.state='waiting_approval'
          if(event.type==='approval/decided')turn.state='running'
          if(event.type==='tool/call')turn.tools.push({id:event.data.callId,title:event.data.name,status:'pending',kind:'other'})
          if(event.type==='tool/result'){const tool=turn.tools.find(t=>t.id===event.data.message.toolCallId);if(tool)tool.status=event.data.message.isError?'failed':'completed'}
          this.changed(record)
        },{global:true})
        const offQuestions=this.ctx.on('user-questions/request',async(request,next)=>{
          if(request.agent?.id!==record.acpSessionId)return next()
          turn.state='waiting_input';this.changed(record);await this.save()
          try{return await next()}finally{if(active.turn===turn&&!active.cancelled){turn.state='running';this.changed(record)}}
        },{global:true})
        try{
          await this.native('prompt',{sessionId:record.acpSessionId,requestId:'opl-harness-'+hash([record.id,turn.operationId]),mode:'queue',content:[{type:'text',text:turn.prompt}]})
          const agent=this.ctx.agents.get(brandString<SessionId>(record.acpSessionId));if(!agent)throw Error('DSH 会话未就绪')
          await agent.whenIdle()
          const result=await waitForSession(this.ctx,{sessionId:agent.id},new AbortController().signal)
          turn.state=result.outcome.kind==='completed'?'completed':result.outcome.kind==='cancelled'?'cancelled':'failed'
          turn.stopReason=result.outcome.kind
        }finally{unlisten();offQuestions()}
      }
    }catch{turn.state=active.cancelled?'cancelled':'failed';turn.error='执行未完成，请检查 Grok 安装、Gateway 连接或原生会话状态。原任务未自动重发。'}
    finally {
      for(const p of active.approvals.values())active.acp?.answer(p.rpcId)
      active.approvals.clear();active.turn=undefined;this.changed(record)
      await this.save().catch(()=>{turn.state='failed';turn.error='结果未能持久保存，请检查磁盘后重试读取';this.changed(record)})
    }
  }
  async wait(input:{sessionId:string;operationId?:string},signal:AbortSignal):Promise<HarnessSnapshot> {
    await this.ready; signal.throwIfAborted()
    return new Promise((resolve,reject)=>{
      const cleanup=()=>{this.events.off(input.sessionId,check);signal.removeEventListener('abort',abort)}
      const abort=()=>{cleanup();reject(Error('等待已取消，任务可通过 snapshot 读取'))}
      const check=()=>{const r=this.records.get(input.sessionId);if(!r){cleanup();reject(Error('组合会话不存在'));return}
        const t=input.operationId?r.turns.find(t=>t.operationId===input.operationId):r.turns.at(-1)
        if(input.operationId&&!t){cleanup();reject(Error('operation 不存在'));return}
        if(!t||t.state!=='running'){cleanup();resolve(this.view(r))}
      }
      this.events.on(input.sessionId,check);signal.addEventListener('abort',abort,{once:true});check()
    })
  }
  async cancel(input:{sessionId:string}) {
    await this.ready
    const record=this.records.get(required(input.sessionId,'sessionId')),active=this.active.get(input.sessionId)
    if(!record)throw Error('组合会话不存在')
    if(active?.turn){active.cancelled=true;for(const a of active.approvals.values())active.acp?.answer(a.rpcId);active.approvals.clear()
      await Promise.all([...this.records.values()].filter(child=>this.parentOf(child.origin)?.id===record.id&&this.active.get(child.id)?.turn).map(child=>this.cancel({sessionId:child.id})))
      if(record.combination===DSH_COMBINATION)await this.native('cancel',{sessionId:record.acpSessionId})
      else active.acp?.cancel(record.acpSessionId)
      const timer=setTimeout(()=>{void active.acp?.dispose()},5000)
      await active.done;clearTimeout(timer)
    }
    return this.view(record)
  }
  async invoke(method:string,input:unknown,signal=new AbortController().signal):Promise<unknown> {
    const p=object(input)
    switch(method){
      case'list':return this.list()
      case'catalog':return this.executionCatalog()
      case'save-catalog':return this.saveExecutionCatalog(p.catalog)
      case'start':return this.start(p as HarnessStartRequest)
      case'prompt':return this.prompt(p as HarnessPromptRequest)
      case'snapshot':return this.snapshot({sessionId:p.sessionId})
      case'cancel':return this.cancel({sessionId:p.sessionId})
      case'wait':return this.wait({sessionId:p.sessionId,...(p.operationId?{operationId:p.operationId}:{})},signal)
      case'answer':return this.answer(p as {sessionId:string;approvalId:string;optionId?:string})
      default:throw Error('不支持的组合操作')
    }
  }
  async dispose(){
    this.disposed=true;await this.ready
    await Promise.allSettled([...this.connecting.values()])
    await Promise.all([...this.active.entries()].map(async([id,a])=>{await this.cancel({sessionId:id});await a.acp?.dispose();await a.bridgeStop?.()}))
    await this.writeQueue; await this.catalogStore.dispose()
  }
}
export const createHarnessService=(ctx:Context)=>new HarnessService(ctx)
