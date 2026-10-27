/**
 * OpenCode external message-edit driver.
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
import { startOpenCodeControl } from './adapters/opencode/opencode-control.ts'

export function createOpenCodeMessageEditDriver(
  startControl: StartVendorControl = startOpenCodeControl,
): ExternalMessageEditDriver {
  return createVendorMessageEditDriver('opencode', startControl)
}

/** Default driver wired to the official OpenCode `serve` control. */
export const openCodeMessageEditDriver: ExternalMessageEditDriver =
  createOpenCodeMessageEditDriver()

export { ExternalMessageEditError } from './message-edit-opencode-common.ts'
export type {
  ExternalMessageEditFailure,
  StartVendorControl,
} from './message-edit-opencode-common.ts'
