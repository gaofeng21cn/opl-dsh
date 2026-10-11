import { createTestDom } from './dom.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { HarnessToolRow } from '../../src/execution/client/HarnessToolRow.tsx'
import { TerminalBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  harnessToolOutput,
  harnessToolDiffs,
  harnessToolExitCode,
} from '../../src/execution/contracts/tool-display.ts'
// Test the OPL props and disclosure composition; official atoms run in desktop qualification.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  StateDot: () => null,
  DisclosureRow: ({ title, open, children }: any) =>
    React.createElement('div', {}, title, open ? children : null),
  TerminalBlock: vi.fn(({ command, output, exitCode, labels }: any) =>
    React.createElement(
      'div',
      { 'data-terminal': '' },
      command,
      output,
      exitCode !== undefined && exitCode !== 0 ? labels.exitCode(exitCode) : '',
    ),
  ),
  DiffBlock: ({ diffs }: any) =>
    React.createElement('div', { 'data-diff': '' }, JSON.stringify(diffs)),
}))

const dom = createTestDom()
let dispose: (() => void) | undefined
afterEach(async () => {
  await React.act(async () => dispose?.())
  dispose = undefined
})

async function render(tool: Record<string, unknown>, isError = false) {
  const container = dom.document.createElement('div')
  dom.document.body.appendChild(container)
  const root = createRoot(container as unknown as HTMLElement)
  dispose = () => root.unmount()
  function View() {
    const [expanded, setExpanded] = React.useState(true)
    return React.createElement(HarnessToolRow, {
      phase: 'result',
      toolName: 'opl_harness_tool',
      callId: 'external-test',
      cwd: 'C:/src/test',
      block: {
        kind: 'tool-result',
        content: [],
        isError,
        call: { name: 'opl_harness_tool', argsRaw: JSON.stringify({ version: 1, tool }) },
        meta: { oplHarness: tool },
      },
      useDisclosure: () => ({ expanded, setExpanded, toggle: () => setExpanded(!expanded) }),
      openFile: () => {},
      loadImage: async () => '',
    } as any)
  }
  await React.act(async () => root.render(React.createElement(View)))
  return container
}

describe('external Harness tool presentation', () => {
  it('renders shell command and unescaped output using the official terminal surface', async () => {
    const tool = {
      title: 'bash',
      kind: 'execute',
      inputJson: JSON.stringify({ command: 'printf "你好"' }),
      outputJson: JSON.stringify({ stdout: '你好\nsecond line', stderr: '', exitCode: 0 }),
    }
    const container = await render(tool)
    expect(container.textContent).toContain('printf "你好"')
    expect(container.textContent).toContain('你好\nsecond line')
    expect(container.textContent).toContain('原始记录')
    expect(container.textContent).not.toContain('未返回退出码')
  })
  it('preserves a real failing exit code and distinguishes missing exit status', async () => {
    const container = await render(
      {
        title: 'bash',
        kind: 'execute',
        inputJson: JSON.stringify({ command: 'false' }),
        outputJson: JSON.stringify({ stdout: '', stderr: 'failure', exitCode: 7 }),
      },
      true,
    )
    expect(container.textContent).toContain('退出码 7')
    expect(container.textContent).toContain('failure')
  })
  it('decodes the official mcode text result and nested execution status', async () => {
    const tool = {
      id: 'mcode-live',
      title: 'bash',
      status: 'completed',
      kind: 'execute',
      inputJson: JSON.stringify({ command: 'pwd; printf "OK\\n"' }),
      outputJson: JSON.stringify({
        content: [{ type: 'text', text: '/tmp/project\nOK\n' }],
        details: {
          execution: { status: 'succeeded', exitCode: 0 },
          processOutput: { stdout: '/tmp/project\nOK\n', stderr: '', exitCode: 0 },
        },
      }),
    }
    expect(harnessToolOutput(tool)).toBe('/tmp/project\nOK\n')
    expect(harnessToolExitCode(tool)).toBe(0)
    const container = await render(tool)
    expect(container.textContent).toContain('/tmp/project\nOK\n')
    expect(vi.mocked(TerminalBlock).mock.lastCall?.[0]).toMatchObject({
      output: '/tmp/project\nOK\n',
      exitCode: 0,
    })
    expect(
      harnessToolOutput({
        ...tool,
        outputJson: JSON.stringify({
          details: { processOutput: { stdout: 'out', stderr: 'err' } },
        }),
      }),
    ).toBe('out\nerr')
    expect(
      harnessToolExitCode({
        ...tool,
        outputJson: JSON.stringify({ details: { execution: { exitCode: 9 } } }),
      }),
    ).toBe(9)
  })
  it('uses CLI structured text and diff previews without reading files', () => {
    const tool = {
      id: 'read',
      title: 'read',
      status: 'completed',
      kind: 'read',
      outputJson: JSON.stringify({ opaque: 'large payload' }),
      contentJson: JSON.stringify([
        { type: 'content', content: { type: 'text', text: 'line one\nline two' } },
      ]),
    }
    expect(harnessToolOutput(tool)).toBe('line one\nline two')
    expect(
      harnessToolDiffs({
        ...tool,
        contentJson: JSON.stringify([
          { type: 'diff', path: 'a.ts', oldText: 'old', newText: 'new' },
        ]),
      }),
    ).toEqual([{ path: 'a.ts', oldText: 'old', newText: 'new' }])
  })
})
