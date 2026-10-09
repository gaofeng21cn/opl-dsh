/** Read-only presentation of ACP tool payloads; the original payload stays in the log. */
import type { HarnessTool } from './sessions.ts'

/** Wire tool name owned only by the external-transcript renderer. */
export const HARNESS_TRANSCRIPT_TOOL = 'opl_harness_tool'

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function json(value: string | undefined): unknown {
  if (value === undefined) return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}
function array(value: string | undefined): unknown[] {
  const parsed = json(value)
  return Array.isArray(parsed) ? parsed : []
}

/** Parse an OPL transcript call without interpreting arbitrary native tool arguments. */
export function transcriptTool(
  argsRaw: string | undefined,
  meta?: unknown,
): HarnessTool | undefined {
  const stored = object(meta).oplHarness
  let call: unknown
  if (argsRaw) {
    try {
      call = JSON.parse(argsRaw)
    } catch {
      /* Truncated historical input has no structured view. */
    }
  }
  const envelope = object(call)
  const tool = object(stored ?? (envelope.version === 1 ? envelope.tool : undefined))
  if (typeof tool.title !== 'string' || typeof tool.kind !== 'string') return undefined
  return tool as unknown as HarnessTool
}

/** Human-readable text supplied by the CLI, preferring its structured preview. */
export function harnessToolOutput(tool: HarnessTool): string {
  const previews = array(tool.contentJson).flatMap((value) => {
    const block = object(value),
      content = object(block.content)
    return block.type === 'content' && content.type === 'text' && typeof content.text === 'string'
      ? [content.text]
      : []
  })
  if (previews.length) return previews.join('\n')
  if (typeof json(tool.outputJson) === 'string') return json(tool.outputJson) as string
  const output = object(json(tool.outputJson))
  const text = Array.isArray(output.content)
    ? output.content.flatMap((value) => {
        const block = object(value)
        return block.type === 'text' && typeof block.text === 'string' ? [block.text] : []
      })
    : []
  if (text.length) return text.join('\n')
  const processOutput = object(object(output.details).processOutput)
  const actualOutput = Object.keys(processOutput).length ? processOutput : output
  const streams = [actualOutput.stdout, actualOutput.stderr].filter(
    (value): value is string => typeof value === 'string',
  )
  if (streams.length) return streams.filter(Boolean).join('\n')
  for (const key of ['output', 'text', 'content', 'error'])
    if (typeof output[key] === 'string') return output[key]
  return tool.outputJson === undefined ? '' : (JSON.stringify(json(tool.outputJson), null, 2) ?? '')
}

/** Salient input without JSON escaping; unused fields remain available in raw details. */
export function harnessToolInput(tool: HarnessTool): string {
  if (typeof json(tool.inputJson) === 'string') return json(tool.inputJson) as string
  const input = object(json(tool.inputJson))
  for (const key of ['command', 'path', 'filePath', 'file_path', 'pattern', 'query'])
    if (typeof input[key] === 'string') return input[key]
  return ''
}

/** CLI-authored file comparisons, without reading files or reconstructing missing old text. */
export function harnessToolDiffs(
  tool: HarnessTool,
): { path: string; oldText: string | null; newText: string }[] {
  return array(tool.contentJson).flatMap((value) => {
    const block = object(value)
    return block.type === 'diff' &&
      typeof block.path === 'string' &&
      typeof block.newText === 'string'
      ? [
          {
            path: block.path,
            oldText: typeof block.oldText === 'string' ? block.oldText : null,
            newText: block.newText,
          },
        ]
      : []
  })
}

/** Exit status appears only when actually reported by the CLI. */
export function harnessToolExitCode(tool: HarnessTool): number | undefined {
  const output = object(json(tool.outputJson))
  const details = object(output.details)
  const code =
    output.exitCode ??
    output.exit_code ??
    object(details.execution).exitCode ??
    object(details.processOutput).exitCode
  return typeof code === 'number' && Number.isInteger(code) ? code : undefined
}
