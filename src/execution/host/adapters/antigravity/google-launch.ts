import { fileURLToPath } from 'node:url'
import { commandLaunch } from '../../harness-registry.ts'

/** Use the official personal-account provider for this invocation only. */
export function googleAccountLaunch(
  command: string,
  prefix: readonly string[] | undefined,
  args: readonly string[],
) {
  const settings =
    process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)
      ? fileURLToPath(new URL('./google-settings.json', import.meta.url))
      : '{"modelProvider":""}'
  return commandLaunch(command, [...(prefix ?? []), '--settings', settings, ...args])
}
