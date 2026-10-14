/** Refuse a CLI success report without a visible answer or completed tool result. */
import type { HarnessTurnOutcome, HarnessResultVerdict } from './types.ts'

/**
 * Validate the observations from one transport-success turn.
 * @param outcome - final body and tool statuses recorded for the turn.
 * @returns acceptance or a fixed diagnostic without provider-controlled text.
 */
export function acceptVisibleCliResult(outcome: HarnessTurnOutcome): HarnessResultVerdict {
  if (outcome.text.trim() || outcome.tools.some((tool) => tool.status === 'completed'))
    return { accepted: true }
  return {
    accepted: false,
    reason: 'Harness 已结束，但本轮没有正文或完成的工具结果。',
  }
}
