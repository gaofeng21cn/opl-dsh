import { useEffect, useState } from 'react'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './SettingsSection.module.css'
interface Status { installed: boolean; autoStart: boolean; version: string; wakeTransport: string; wakeExecution: string; wakeExecutable: string; wakeDistro: string; update: { state?: string } }
export function CoordinationSection({ call }: { call: (action: string, value?: unknown) => Promise<unknown> }) {
  const [status,setStatus]=useState<Status>(),[busy,setBusy]=useState(false),[notice,setNotice]=useState('')
  const load=async()=>setStatus(await call('coordination-status') as Status)
  useEffect(()=>{void load().catch(()=>setNotice('无法读取协作配置，请重新运行增强安装器。'))},[call])
  const act=async(action:string,value?:unknown)=>{setBusy(true);setNotice('');try{await call(action,value);await load();setNotice(action==='wake-settings'?'已保存，重新打开 OPL DSH 后生效。':'已保存。')}catch{setNotice('操作未完成。手动修改过的 Skill 会被保留，请检查安装状态。')}finally{setBusy(false)}}
  return <div className={css.section}>
    <h2 className={css.title}>Codex 协作</h2><p className={css.intro}>在 Codex 中派发任务，由 DSH 执行并返回结果。</p>
    <div className={css.card}><h3 className={css.name}>{!status ? '正在读取协作状态…' : status.installed ? '协作 Skill 已就绪' : '协作 Skill 未安装'}</h3><p className={css.muted}>支持自动启动、连续任务、权限等待、持久化反馈与结果验收。</p><Button variant='outline' disabled={busy || !status} onClick={()=>{void act('skill-install')}}>{status?.installed?'更新 / 修复 Skill':'安装 Skill'}</Button>
      <div className={css.row}><span>Codex 派发任务时自动启动 DSH</span><Switch label='Codex 派发任务时自动启动 DSH' checked={status?.autoStart??true} disabled={busy||!status} onChange={value=>{void act('auto-start',value)}} /></div>
    </div>
    <details className={css.details}><summary>任务完成通知</summary><div className={css.detailsBody}><p className={css.muted}>任务反馈始终保存在本机。主动唤醒 Codex 需要可用的队列桥；未配置时可在 Codex 中等待或读取反馈。</p>
      {status&&<div className={css.form}>
        <label className={css.field}><span>回调方式</span><select className={css.input} disabled={busy} value={status.wakeTransport} onChange={e=>setStatus({...status,wakeTransport:e.target.value})}><option value='unconnected'>不主动唤醒</option><option value='codex-queue'>Codex 队列桥</option></select></label>
        {status.wakeTransport==='codex-queue'&&<><label className={css.field}><span>运行环境</span><select className={css.input} disabled={busy} value={status.wakeExecution} onChange={e=>setStatus({...status,wakeExecution:e.target.value})}><option value='native'>本机</option><option value='wsl'>WSL</option></select></label><label className={css.field}><span>队列桥可执行文件</span><input disabled={busy} className={css.input} value={status.wakeExecutable} onChange={e=>setStatus({...status,wakeExecutable:e.target.value})}/></label>{status.wakeExecution==='wsl'&&<label className={css.field}><span>WSL 发行版</span><input disabled={busy} className={css.input} value={status.wakeDistro} onChange={e=>setStatus({...status,wakeDistro:e.target.value})}/></label>}</>}
        <Button variant='outline' disabled={busy || !status} onClick={()=>{void act('wake-settings',status)}}>保存通知设置</Button>
      </div>}</div>
    </details>
    <details className={css.details}><summary>OPL 增强更新</summary><p className={css.muted}>当前官方桌面版本 {status?.version??'—'}。在桌面启动前自动检查并安装兼容增强；应用运行中不更换插件，网络不可用时继续使用当前版本。官方桌面可独立更新。</p></details>
    {notice&&<p className={css.notice} role='status'>{notice}</p>}
  </div>
}
