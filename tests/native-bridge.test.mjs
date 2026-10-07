import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { copyFile, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
test(
  'packaged bridge resumes native Codex identity and refuses sandbox escalation',
  async () => {
    const bridge = fileURLToPath(
      new URL('../dist/package/lib/native-harness-bridge.mjs', import.meta.url),
    )
    const fixture = fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url))
    // The bridge spawns the native command as an executable, which relies on the fixture's
    // shebang. Windows cannot execute a shebang script, so there the fixture is started with
    // the current Node binary from a directory holding it as the extensionless `app-server`
    // entry point. The ACP assertions below stay identical on every platform.
    const windows = process.platform === 'win32'
    const scratch = windows ? await mkdtemp(join(tmpdir(), 'opl-native-bridge-')) : undefined
    try {
      if (scratch) await copyFile(fixture, join(scratch, 'app-server'))
      const cwd = await realpath(scratch ?? '.'),
        output = []
      const child = spawn(process.execPath, [bridge], {
        cwd,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          OPL_NATIVE_HARNESS: 'codex',
          OPL_NATIVE_COMMAND: scratch ? process.execPath : fixture,
          OPL_NATIVE_MODEL: 'gpt-6-luna',
          OPL_NATIVE_PERMISSION: 'read-only',
          OPL_NATIVE_API_KEY: 'fixture',
          OPL_NATIVE_BASE_URL: 'http://127.0.0.1:1/v1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      child.stderr.resume()
      const closed = new Promise((resolve, reject) => {
        child.once('exit', resolve)
        child.once('error', reject)
      })
      let seq = 0
      const pending = new Map()
      createInterface({ input: child.stdout }).on('line', (line) => {
        const m = JSON.parse(line)
        if (m.method === 'session/update') output.push(m.params.update.content.text)
        else {
          const p = pending.get(m.id)
          if (p) {
            pending.delete(m.id)
            m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result)
          }
        }
      })
      const call = (method, params = {}) =>
        new Promise((resolve, reject) => {
          const id = ++seq
          pending.set(id, { resolve, reject })
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
        })
      try {
        await call('initialize')
        const session = await call('session/load', {
          cwd,
          sessionId: 'existing-native-id',
          mcpServers: [],
        })
        assert.equal(session.sessionId, 'existing-native-id')
        assert.deepEqual(
          await call('session/prompt', {
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text: 'test' }],
            _meta: { reasoningEffort: 'high' },
          }),
          { stopReason: 'end_turn' },
        )
        assert.equal(output.join(''), 'boundary preserved')
      } finally {
        child.kill()
        await closed
      }
    } finally {
      // Windows keeps the working directory locked until the harness process is gone.
      if (scratch)
        await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  },
  { timeout: 10000 },
)
// A `.cmd`/`.bat` launcher is not an executable image: it must be handed to cmd.exe and can live
// under an absolute path with spaces. Node's own Windows argument escaping used to turn the inner
// quotes of that path into \" before cmd.exe ever saw it, so the script was never resolved. This
// drives the bridge source directly (Node >= 24 strips the types) because the packaged bundle is a
// build artifact, and it asserts a real ACP round trip rather than the spawn argument array.
for (const extension of ['cmd', 'bat'])
  test(
    `bridge starts a native Codex .${extension} launcher whose path contains spaces`,
    { skip: process.platform !== 'win32', timeout: 20000 },
    async () => {
      const bridge = fileURLToPath(
        new URL('../src/execution/host/adapters/native-harness-bridge.ts', import.meta.url),
      )
      const fixture = fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url))
      const scratch = await mkdtemp(join(tmpdir(), 'opl native bridge '))
      try {
        const cwd = await realpath(scratch)
        await copyFile(fixture, join(scratch, 'codex-app-server.mjs'))
        const launcher = join(scratch, `codex app-server.${extension}`)
        await writeFile(
          launcher,
          `@echo off\r\n"${process.execPath}" "%~dp0codex-app-server.mjs" %*\r\n`,
        )
        const output = []
        const child = spawn(process.execPath, [bridge], {
          cwd,
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            SystemRoot: process.env.SystemRoot,
            ComSpec: process.env.ComSpec,
            OPL_NATIVE_HARNESS: 'codex',
            OPL_NATIVE_COMMAND: launcher,
            OPL_NATIVE_MODEL: 'gpt-6-luna',
            OPL_NATIVE_PERMISSION: 'read-only',
            OPL_NATIVE_API_KEY: 'fixture',
            OPL_NATIVE_BASE_URL: 'http://127.0.0.1:1/v1',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        child.stderr.resume()
        const closed = new Promise((resolve, reject) => {
          child.once('exit', resolve)
          child.once('error', reject)
        })
        let seq = 0
        const pending = new Map()
        createInterface({ input: child.stdout }).on('line', (line) => {
          const m = JSON.parse(line)
          if (m.method === 'session/update') output.push(m.params.update.content.text)
          else {
            const p = pending.get(m.id)
            if (p) {
              pending.delete(m.id)
              m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result)
            }
          }
        })
        const call = (method, params = {}) =>
          new Promise((resolve, reject) => {
            const id = ++seq
            pending.set(id, { resolve, reject })
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
          })
        try {
          await call('initialize')
          const session = await call('session/load', {
            cwd,
            sessionId: 'existing-native-id',
            mcpServers: [],
          })
          assert.equal(session.sessionId, 'existing-native-id')
          assert.deepEqual(
            await call('session/prompt', {
              sessionId: session.sessionId,
              prompt: [{ type: 'text', text: 'test' }],
              _meta: { reasoningEffort: 'high' },
            }),
            { stopReason: 'end_turn' },
          )
          assert.equal(output.join(''), 'boundary preserved')
        } finally {
          child.kill()
          await closed
        }
      } finally {
        // Windows keeps the working directory locked until the harness process is gone.
        await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
      }
    },
  )
