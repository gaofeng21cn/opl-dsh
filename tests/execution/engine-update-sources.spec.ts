import { it, expect } from 'vitest'
import {
  checkEngineUpdate,
  applyEngineUpdate,
} from '../../src/execution/host/engine-update-sources.ts'
import type { HarnessInstallation } from '../../src/execution/contracts/installations.ts'
const item: HarnessInstallation = {
  id: 'minimax-code',
  name: 'MiniMax',
  path: '/custom/mcode',
  version: '0.7.7-opl-bash.20261119.1',
  installed: true,
  runnable: true,
  instructions: '',
  website: '',
  maintenanceAction: 'update',
}
it('keeps OPL Git Bash, hard-pinned Qwen and custom installer roots outside official upgrades', async () => {
  for (const value of [
    item,
    { ...item, id: 'qwen-code', version: '0.27.3' },
    { ...item, id: 'kimi-code', version: '2.1.1' },
  ]) {
    expect((await checkEngineUpdate(value)).status).toBe('unsupported')
    await expect(applyEngineUpdate(value, '99.0.0')).rejects.toThrow('更新目标已变化')
  }
})

it('leaves the Codex CLI inside ChatGPT.app to the desktop updater', async () => {
  const bundled = {
    ...item,
    id: 'codex',
    version: 'codex-cli 0.169.1',
    path: '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
  }
  expect(await checkEngineUpdate(bundled)).toMatchObject({
    status: 'unsupported',
    message: expect.stringContaining('随桌面应用更新'),
  })
  await expect(applyEngineUpdate(bundled, '99.0.0')).rejects.toThrow('更新目标已变化')
})
