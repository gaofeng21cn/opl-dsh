/** MCP stdio adapter with a per-parent capability, never the general Host token. */
import { createInterface } from 'node:readline'
const endpoint=process.env.OPL_HARNESS_ENDPOINT,token=process.env.OPL_HARNESS_TOKEN
if(!endpoint||!token)throw Error('Missing OPL Harness capability')
const call=async(method,input)=>{
 const response=await fetch(endpoint,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({namespace:'harness',method,args:input,timeoutMs:600000}),signal:AbortSignal.timeout(605000)})
 const result=await response.json();if(!result.ok)throw Error(result.error);return result.value
}
const tools=[{name:'delegate_to_harness',description:'在当前项目创建关联的 DeepSeek + 官方 DSH 子对话，或继续原子对话。传入明确任务和稳定 task/operation ID；结果返回本对话。',inputSchema:{type:'object',properties:{task:{type:'string'},taskId:{type:'string'},operationId:{type:'string'},sessionId:{type:'string'}},required:['task','taskId','operationId'],additionalProperties:false}},
 {name:'harness_result',description:'读取或等待此对话创建的子任务结果。权限请求由人在 DSH 确认。',inputSchema:{type:'object',properties:{sessionId:{type:'string'},wait:{type:'boolean'}},required:['sessionId'],additionalProperties:false}}]
async function handle(m){
 if(m.id===undefined)return
 let result
 try{
  if(m.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'opl-harness-cooperation',version:'1.0.0'}}
  else if(m.method==='ping')result={}
  else if(m.method==='tools/list')result={tools}
  else if(m.method==='tools/call'){
   const a=m.params?.arguments??{};let value
   try{
    if(m.params?.name==='delegate_to_harness'){
     const session=await call('start',{taskId:a.taskId,...(a.sessionId?{existingSessionId:a.sessionId}:{})})
     await call('prompt',{sessionId:session.id,text:a.task,operationId:a.operationId})
     value=await call('wait',{sessionId:session.id,operationId:a.operationId})
    }else if(m.params?.name==='harness_result')value=await call(a.wait?'wait':'snapshot',{sessionId:a.sessionId})
    else throw Error('Unknown tool')
    result={content:[{type:'text',text:JSON.stringify(value)}]}
   }catch(e){result={isError:true,content:[{type:'text',text:e instanceof Error?e.message:'Harness request failed'}]}}
  }else {process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Method not found'}})+'\n');return}
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\n')
 }catch{process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:'MCP request failed'}})+'\n')}
}
createInterface({input:process.stdin}).on('line',line=>{try{void handle(JSON.parse(line))}catch{}})
