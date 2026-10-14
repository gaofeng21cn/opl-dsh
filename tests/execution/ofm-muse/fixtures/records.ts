import type { HarnessSession } from '../../../../src/execution/contracts/sessions.ts'
import type { ModelRef } from '../../../../src/execution/contracts/catalog.ts'
import { MUSE_PROVIDER } from '../../../../src/execution/host/adapters/muse/muse-models.ts'

/** Build a session record for one lane, with only the fields this adapter reads. */
export function museRecord(
  modelRef: ModelRef,
  extra: Partial<HarnessSession> = {},
): HarnessSession {
  return {
    id: 'session-ofm-muse',
    harnessRef: 'muse-code',
    modelRef,
    cwd: process.cwd(),
    sandbox: 'full-access',
    acpSessionId: '',
    ...extra,
  } as HarnessSession
}

/** The reference shape tests use most, so a lane change breaks one place. */
export const museRef = (model: string): ModelRef => ({ provider: MUSE_PROVIDER, model })
