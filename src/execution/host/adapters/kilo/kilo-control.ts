/** Authenticated temporary `kilo serve` control for message-edit history/fork. */
import type { ExternalEditContext } from '../../message-edit-driver.ts'
import {
  startAuthenticatedControl,
  type VendorControl,
} from '../../message-edit-opencode-common.ts'

export function startKiloControl(context: ExternalEditContext): Promise<VendorControl> {
  return startAuthenticatedControl(context, {
    passwordEnv: 'KILO_SERVER_PASSWORD',
    usernameEnv: 'KILO_SERVER_USERNAME',
    defaultUsername: 'kilo',
  })
}
