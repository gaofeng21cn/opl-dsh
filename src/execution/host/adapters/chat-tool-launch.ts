/** Launch the owned stream compatibility bridge around an unchanged official CLI. */
import { fileURLToPath } from 'node:url'
import type { AdapterLaunch } from './types.ts'

export function chatToolCompatibilityLaunch(
  launch: AdapterLaunch,
  family: 'opencode' | 'kilo',
): AdapterLaunch {
  return {
    home: launch.home,
    command: process.execPath,
    args: [fileURLToPath(new URL('./chat-tool-bridge.mjs', import.meta.url))],
    env: {
      ...launch.env,
      ELECTRON_RUN_AS_NODE: '1',
      OPL_CHAT_CLI: family,
      OPL_CHAT_COMMAND: launch.command,
      OPL_CHAT_ARGS: JSON.stringify(launch.args),
      OPL_CHAT_VERBATIM: launch.windowsVerbatimArguments ? '1' : '0',
    },
  }
}
