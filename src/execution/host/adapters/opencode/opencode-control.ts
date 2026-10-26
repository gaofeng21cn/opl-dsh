/** Authenticated temporary `opencode serve` control for message-edit history/fork. */
import type { ExternalEditContext } from '../../message-edit-driver.ts'
import {
  startAuthenticatedControl,
  type VendorControl,
} from '../../message-edit-opencode-common.ts'

export function startOpenCodeControl(context: ExternalEditContext): Promise<VendorControl> {
  return startAuthenticatedControl(context, {
    passwordEnv: 'OPENCODE_SERVER_PASSWORD',
    usernameEnv: 'OPENCODE_SERVER_USERNAME',
    defaultUsername: 'opencode',
  })
}
