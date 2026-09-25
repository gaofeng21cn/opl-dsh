import {mkdtemp,readFile,rm,access} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {afterEach,describe,expect,it} from 'vitest'
import type {Context} from '@deepseek-ai/cordis'
import {HarnessService,GROK_COMBINATION,grokConfiguration} from '../../src/coordination/harness.ts'
const cleanups:(()=>Promise<unknown>)[]=[]
afterEach(async()=>{while(cleanups.length)await cleanups.pop()!()})
async function setup(){const root=await mkdtemp(join(tmpdir(),'opl-acp-test-'));cleanups.push(()=>rm(root,{recursive:true,force:true}));const options={home:join(root,'state'),command:process.execPath,prefix:[resolve('tests/fixtures/acp-agent.mjs')],resolveKey:async()=> 'test-grok-key'};const ctx={get:()=>undefined,agents:{get:()=>undefined}} as unknown as Context;const service=new HarnessService(ctx,options);cleanups.push(()=>service.dispose());return {root,options,ctx,service}}
const start=(s:HarnessService,cwd:string,taskId='task')=>s.start({combination:GROK_COMBINATION,cwd,taskId,origin:{kind:'codex',sessionId:'parent'}})
const wait=(s:HarnessService,id:string)=>s.wait({sessionId:id},AbortSignal.timeout(8000))
describe('external Harness production transport',()=>{
 it('parses ACP envelopes, deduplicates task/operation, preserves results and restores native sessions',async()=>{
  const {root,service,ctx,options}=await setup();const [a,b]=await Promise.all([start(service,root),start(service,root)]);expect(a.id).toBe(b.id)
  await service.prompt({sessionId:a.id,text:'remember-721',operationId:'one'});const first=await wait(service,a.id)
  expect(first.turns[0]).toMatchObject({state:'completed',text:'result:remember-721'});expect(first.turns[0]?.tools).toHaveLength(1)
  await service.prompt({sessionId:a.id,text:'remember-721',operationId:'one'})
  await expect(service.prompt({sessionId:a.id,text:'changed',operationId:'one'})).rejects.toThrow('operation')
  expect((await readFile(join(root,'calls.txt'),'utf8')).trim().split('\n')).toHaveLength(1)
  await service.dispose();const resumed=new HarnessService(ctx,options);cleanups.push(()=>resumed.dispose());await resumed.start({combination:GROK_COMBINATION,cwd:root,existingSessionId:a.id})
  await resumed.prompt({sessionId:a.id,text:'recall',operationId:'two'});expect((await wait(resumed,a.id)).turns[1]?.text).toBe('remember-721')
  const launch=JSON.parse(await readFile(join(root,'launch.json'),'utf8'));expect(launch).toMatchObject({envKey:true,hasCodex:false})
  expect(await readFile(join(options.home,'harnesses/grok-build/config.toml'),'utf8')).not.toContain('test-grok-key')
 })
 it('holds permission until explicit choice and denies without file writes',async()=>{
  const {root,service}=await setup();const a=await start(service,root)
  await service.prompt({sessionId:a.id,text:'deny-write',operationId:'deny'});const pending=await wait(service,a.id);expect(pending.state).toBe('waiting_approval')
  expect(await access(join(root,'controlled.txt')).then(()=>true,()=>false)).toBe(false)
  const ask=pending.approvals[0]!;await expect(service.answer({sessionId:a.id,approvalId:ask.id,optionId:'invalid'})).rejects.toThrow()
  await service.answer({sessionId:a.id,approvalId:ask.id,optionId:'no'});expect((await wait(service,a.id)).turns[0]?.text).toBe('denied')
  expect(await access(join(root,'controlled.txt')).then(()=>true,()=>false)).toBe(false)
  await service.prompt({sessionId:a.id,text:'allow-write',operationId:'allow'});const approval=(await wait(service,a.id)).approvals[0]!
  await service.answer({sessionId:a.id,approvalId:approval.id,optionId:'yes'});await wait(service,a.id);expect(await readFile(join(root,'controlled.txt'),'utf8')).toBe('approved')
 })
 it('cancels with a notification and rejects parallel prompts and mismatched resumes',async()=>{
  const {root,service}=await setup();const a=await start(service,root)
  await service.prompt({sessionId:a.id,text:'wait',operationId:'one'})
  await expect(service.prompt({sessionId:a.id,text:'again',operationId:'two'})).rejects.toThrow('执行')
  expect((await service.cancel({sessionId:a.id})).state).toBe('cancelled')
  await expect(service.start({combination:'fake',cwd:root})).rejects.toThrow()
  await expect(service.start({combination:GROK_COMBINATION,cwd:root,existingSessionId:'missing'})).rejects.toThrow('不存在')
  await expect(service.start({combination:GROK_COMBINATION,cwd:tmpdir(),existingSessionId:a.id})).rejects.toThrow('不一致')
 })
 it('fails closed without a Grok key and never falls back to machine credentials',async()=>{
  const {root,ctx,options}=await setup();const service=new HarnessService(ctx,{...options,resolveKey:async()=>undefined});cleanups.push(()=>service.dispose())
  await expect(start(service,root)).rejects.toThrow('分组密钥')
  expect(grokConfiguration()).toContain('env_key = "OPL_GATEWAY_GROK_API_KEY"')
 })
})
