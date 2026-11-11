/**
 * Kilo external message-edit driver.
 *
 * The shared owner supplies the record, launch environment, transport and lifecycle. This
 * driver only reads vendor history and forks before the selected user boundary; it never
 * writes the record, sends a replacement prompt, reverts files or deletes a branch.
 */
import type { HarnessSession } from '../contracts/sessions.ts'
import type { ExternalEditHistory, ExternalMessageEditDriver } from './message-edit-driver.ts'
import {
  createVendorMessageEditDriver,
  ExternalMessageEditError,
  type StartVendorControl,
} from './message-edit-opencode-common.ts'
import { startKiloControl } from './adapters/kilo/kilo-control.ts'
import { kiloPath, kiloProfileRoots } from './adapters/kilo/kilo.ts'
import { systemEnvironment } from './adapters/environment.ts'
import { commandLaunch } from './harness-registry.ts'

export function createKiloMessageEditDriver(
  startControl: StartVendorControl = startKiloControl,
): ExternalMessageEditDriver {
  return createVendorMessageEditDriver('kilo', startControl)
}

/** Default driver wired to the official Kilo `serve` control. */
export const kiloMessageEditDriver: ExternalMessageEditDriver = createKiloMessageEditDriver()

/**
 * Read stored Kilo boundaries without resolving a currently available model or its key.
 * The caller must first close this record's ACP process; only a temporary local history
 * control server is launched. Sending and rewinding still use the ordinary online adapter.
 *
 * @param record - Persisted Kilo identity with terminal turns and no owned ACP process.
 * @param options - Official CLI entry and the same suite profile used by the session.
 * @param signal - Cancellation for command discovery and temporary control lifecycle.
 * @param startControl - Local control factory, injectable without starting a real CLI.
 * @returns Verified vendor user boundaries, without modifying either conversation.
 */
export async function readStoredKiloHistory(
  record: Readonly<HarnessSession>,
  options: { home: string; command?: string; prefix?: readonly string[] },
  signal: AbortSignal,
  startControl: StartVendorControl = startKiloControl,
): Promise<ExternalEditHistory> {
  if (signal.aborted) throw new ExternalMessageEditError('aborted')
  if (record.harnessRef !== 'kilo') throw new ExternalMessageEditError('unsupported')
  if (!record.acpSessionId) throw new ExternalMessageEditError('stale')
  if (
    record.turns.some(
      (turn) => !['completed', 'failed', 'cancelled', 'interrupted'].includes(turn.state),
    )
  )
    throw new ExternalMessageEditError('busy')
  const path = await kiloPath(options)
  if (signal.aborted) throw new ExternalMessageEditError('aborted')
  if (!path) throw new ExternalMessageEditError('control-unavailable')
  const launch = commandLaunch(path, options.prefix ?? [])
  const forbidden = (): never => {
    throw new ExternalMessageEditError('unsupported')
  }
  return createKiloMessageEditDriver(startControl).read({
    record,
    signal,
    launch: {
      ...launch,
      home: options.home,
      env: {
        ...systemEnvironment(),
        ...kiloProfileRoots(options.home),
        KILO_CONFIG_CONTENT: '{}',
        KILO_DISABLE_MODELS_FETCH: '1',
        KILO_DISABLE_AUTOUPDATE: '1',
        OPL_CHAT_EDIT_COMMAND: path,
        OPL_CHAT_EDIT_ARGS: JSON.stringify(options.prefix ?? []),
      },
    },
    snapshot: () => ({ agent: {}, session: {}, configOptions: [] }),
    transport: forbidden,
    disconnect: async () => {},
    reconnect: async () => forbidden(),
    replayHistory: async () => forbidden(),
  })
}

export { ExternalMessageEditError } from './message-edit-opencode-common.ts'
export type {
  ExternalMessageEditFailure,
  StartVendorControl,
} from './message-edit-opencode-common.ts'
