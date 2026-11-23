#!/usr/bin/env node
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { runLifecycle } from '../../src/execution/host/candidates/mcode/lifecycle.ts'

export * from '../../src/execution/host/candidates/mcode/lifecycle.ts'

// ---------------------------------------------------------------- 命令行

export function parseLifecycleArgs(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      store: { type: 'string' },
      source: { type: 'string' },
      manifest: { type: 'string' },
      version: { type: 'string' },
      select: { type: 'boolean', default: false },
      replace: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'active-tasks': { type: 'string' },
      activity: { type: 'string' },
      'allow-root': { type: 'string', multiple: true },
      protect: { type: 'string', multiple: true },
      'official-launcher': { type: 'string' },
      'allow-same-or-older': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
  })
  return {
    command: positionals[0],
    options: {
      store: values.store,
      source: values.source,
      manifest: values.manifest,
      version: values.version,
      select: values.select,
      replace: values.replace,
      dryRun: values['dry-run'],
      activeTasks: values['active-tasks'],
      activity: values.activity,
      allowRoots: (values['allow-root'] ?? []).map((value) => resolve(value)),
      extraRoots: (values.protect ?? []).map((value) => resolve(value)),
      officialLauncher: values['official-launcher'],
      allowSameOrOlder: values['allow-same-or-older'],
      json: values.json,
    },
  }
}

function summarize(result) {
  const lines = [`命令：${result.command}${result.dryRun ? '（dry-run，未写入）' : ''}`]
  lines.push(`结果：${result.ok ? 'OK' : '失败'}`)
  for (const key of ['storeRoot', 'source', 'version', 'destination', 'launcher'])
    if (result[key]) lines.push(`${key}：${result[key]}`)
  if (result.activeTasks)
    lines.push(
      `活动任务：${result.activeTasks.activeTasks}（来源 ${result.activeTasks.source}，调用方注入，非全局探测）`,
    )
  if (result.applied) lines.push('已应用')
  if (result.selectionChanged) lines.push('本地选择回执已更新')
  if (result.integration?.wiredByLifecycle === false)
    lines.push(
      `集成状态：回执未接线（真实选择需 ${result.integration.publicInterface} 设置 ${result.integration.field}）`,
    )
  if (result.runtimeValidation)
    lines.push(`运行时验收：本脚本未做（${result.runtimeValidation.reason}）`)
  if (result.failed?.length) lines.push(`失败项：${result.failed.join(', ')}`)
  for (const item of result.checks ?? [])
    lines.push(`${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.detail ? ` — ${item.detail}` : ''}`)
  for (const warning of result.warnings ?? []) lines.push(`注意：${warning}`)
  if (result.candidates)
    lines.push(`候选：${result.candidates.map((item) => item.version).join(', ') || '（无）'}`)
  if (result.writes)
    lines.push(
      `计划写入：${result.writes.map((item) => `${item.action}→${item.to}`).join('；') || '（无）'}`,
    )
  return lines
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { command, options } = parseLifecycleArgs(process.argv.slice(2))
  if (!command)
    throw new Error(
      '用法：node scripts/mcode-candidate/lifecycle.mjs <list|verify|import|upgrade|select|official> [选项]',
    )
  const { json, ...rest } = options
  const result = runLifecycle(command, rest)
  if (json) console.log(JSON.stringify(result, null, 2))
  else for (const line of summarize(result)) console.log(line)
  if (!result.ok) process.exit(1)
}
