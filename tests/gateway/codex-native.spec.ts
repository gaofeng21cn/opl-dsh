import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { configureNativeCodex } from '../../src/gateway/host/codex-native.ts'

const executable = process.env.OPL_TEST_NATIVE_CODEX
test.skipIf(!executable || !['win32', 'darwin'].includes(process.platform))(
  'a dedicated native key is read back from the system credential manager and a previous login is protected',
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'opl-native-keyring-'))
    const options = { home, executable: executable! }
    const key = 'opl-local-test-' + randomUUID()
    const issuer = async () => key
    const config = join(home, 'config.toml')
    const auth = join(home, 'auth.json')
    try {
      await writeFile(config, '# keep this setting\napproval_policy = "on-request"\n')
      await writeFile(auth, '{}')
      let issued = false
      await expect(
        configureNativeCodex(async () => {
          issued = true
          return key
        }, options),
      ).rejects.toThrow('auth.json')
      expect(issued).toBe(false)
      await rm(auth)
      await configureNativeCodex(issuer, options)
      const text = await readFile(config, 'utf8')
      expect(text).toContain('# keep this setting')
      expect(text).toContain('gpt-6.1-sol')
      expect(text).toContain('cli_auth_credentials_store = "keyring"')
      expect(text).not.toContain(key)
      expect(existsSync(auth)).toBe(false)
      await configureNativeCodex(issuer, options)
      await expect(
        configureNativeCodex(async () => 'opl-different-' + randomUUID(), options),
      ).rejects.toThrow('已有 OPL 登录')
      expect(await readFile(config, 'utf8')).toBe(text)
      await configureNativeCodex(issuer, options)
      for (const entry of await readdir(home, { recursive: true, withFileTypes: true })) {
        if (entry.isFile()) {
          expect((await readFile(join(entry.parentPath, entry.name))).includes(key)).toBe(false)
        }
      }
    } finally {
      const args = ['-c', 'cli_auth_credentials_store="keyring"']
      const env = { ...process.env, CODEX_HOME: home }
      const r = spawnSync(executable!, [...args, 'logout'], {
        env,
        cwd: home,
        stdio: 'ignore',
        windowsHide: true,
      })
      expect(r.status).toBe(0)
      const after = spawnSync(executable!, [...args, 'login', 'status'], {
        env,
        cwd: home,
        encoding: 'utf8',
        windowsHide: true,
      })
      expect(after.status).toBe(1)
      expect(/^Not logged in\s*$/im.test(after.stderr ?? '')).toBe(true)
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  },
  120000,
)
