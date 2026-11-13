/**
 * OPL keeps its structured, user-facing failure codes while rc.2's official
 * constructor accepts only the built-in provider code union. Runtime behavior
 * is unchanged; this narrow boundary preserves the OPL extension codes.
 */
import { LlmError as OfficialLlmError } from '@deepseek-ai/dsh-llm'

export const LlmError = OfficialLlmError as unknown as {
  new (message: string, code: string, options?: unknown): InstanceType<typeof OfficialLlmError>
}
export type LlmError = InstanceType<typeof OfficialLlmError>
