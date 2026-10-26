/**
 * Kilo external message-edit driver.
 *
 * The shared owner supplies the record, launch environment, transport and lifecycle. This
 * driver only reads vendor history and forks before the selected user boundary; it never
 * writes the record, sends a replacement prompt, reverts files or deletes a branch.
 */
import type { ExternalMessageEditDriver } from './message-edit-driver.ts'
import {
  createVendorMessageEditDriver,
  type StartVendorControl,
} from './message-edit-opencode-common.ts'
import { startKiloControl } from './adapters/kilo/kilo-control.ts'

export function createKiloMessageEditDriver(
  startControl: StartVendorControl = startKiloControl,
): ExternalMessageEditDriver {
  return createVendorMessageEditDriver('kilo', startControl)
}

/** Default driver wired to the official Kilo `serve` control. */
export const kiloMessageEditDriver: ExternalMessageEditDriver = createKiloMessageEditDriver()

export { ExternalMessageEditError } from './message-edit-opencode-common.ts'
export type {
  ExternalMessageEditFailure,
  StartVendorControl,
} from './message-edit-opencode-common.ts'
