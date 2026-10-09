/** External tool transcript rendered through the official keyed Tool slot. */
import {
  DisclosureRow,
  StateDot,
  TerminalBlock,
  DiffBlock,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import {
  transcriptTool,
  harnessToolInput,
  harnessToolOutput,
  harnessToolDiffs,
  harnessToolExitCode,
} from '../contracts/tool-display.ts'
import css from './HarnessToolRow.module.css'

const terminalLabels = {
  signal: (value: string) => `信号 ${value}`,
  exitCode: (value: number) => `退出码 ${value}`,
  noExitCode: '未返回退出码',
  running: '运行中',
  failed: '失败',
  done: '完成',
  copy: '复制',
  copied: '已复制',
  noOutput: '无输出',
  collapseAria: '收起输出',
  collapse: '收起',
  expandAria: (n: number) => `展开剩余 ${n} 行`,
  expand: (n: number) => `展开剩余 ${n} 行`,
}
const diffLabels = {
  ...terminalLabels,
  codeLabel: '代码',
  wrapLabel: '换行',
  unwrapLabel: '取消换行',
}

/** Render only recorded CLI data; callbacks never invoke a command or apply a file change. */
export function HarnessToolRow(props: ToolCallViewProps) {
  const disclosure = props.useDisclosure()
  const args =
    props.phase === 'result'
      ? props.block.call?.argsRaw
      : props.phase === 'start'
        ? props.block.argsRaw
        : undefined
  const tool = transcriptTool(args, props.phase === 'result' ? props.block.meta : undefined)
  const input = tool ? harnessToolInput(tool) : ''
  const output = tool ? harnessToolOutput(tool) : ''
  const diffs = tool ? harnessToolDiffs(tool) : []
  const code = tool ? harnessToolExitCode(tool) : undefined
  const failed =
    props.phase === 'result' && (props.block.isError || (code !== undefined && code !== 0))
  const running = props.phase !== 'result'
  const title = tool
    ? `${tool.title}${input ? ' · ' + input.replaceAll('\n', ' ') : ''}`
    : props.toolName
  return (
    <div data-opl-harness-tool="" className={css.wrapper}>
      <DisclosureRow
        icon={<StateDot state={running ? 'ongoing' : failed ? 'error' : 'done'} />}
        title={title}
        open={disclosure.expanded}
        expandable
        onToggle={disclosure.toggle}
        running={running}
        expandOnRowClick
      >
        {tool?.kind === 'execute' && input ? (
          <TerminalBlock
            command={input}
            cwd={props.cwd}
            output={output || undefined}
            exitCode={props.phase === 'result' ? (code ?? null) : undefined}
            running={running}
            labels={terminalLabels}
          />
        ) : diffs.length ? (
          <DiffBlock diffs={diffs} labels={diffLabels} />
        ) : (
          <div className={css.body}>
            {input && <pre>{input}</pre>}
            {output && <pre>{output}</pre>}
          </div>
        )}
        <details className={css.raw}>
          <summary>原始记录</summary>
          <pre>{JSON.stringify(tool ?? { arguments: args }, null, 2)}</pre>
        </details>
      </DisclosureRow>
    </div>
  )
}
