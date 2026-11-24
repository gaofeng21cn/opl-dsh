import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AntigravityAccount,
  readAntigravityModels,
} from '../../src/execution/host/antigravity-account.ts'

describe('official Antigravity Google account', () => {
  it('uses advertised slugs including reasoning variants, ignoring UI text', () => {
    expect(
      readAntigravityModels(
        'Fetching available models...\ngemini-4-neon-xhigh            Gemini 4 Neon (XHigh)\ngemini-4-neon-high\tGemini 4 Neon (High)\ngemini-4-neon-high\tDuplicate',
      ),
    ).toEqual(
      new Map([
        ['gemini-4-neon-xhigh', 'Gemini 4 Neon (XHigh)'],
        ['gemini-4-neon-high', 'Gemini 4 Neon (High)'],
      ]),
    )
  })

  afterEach(() => vi.unstubAllEnvs())

  it('only requests personal OAuth on explicit login and re-reads models after authorization', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opl-agy-account-'))
    const file = join(dir, 'cli.mjs')
    const log = join(dir, 'calls')
    const auth = join(dir, 'fixture-authorized')
    await writeFile(
      file,
      String.raw`
      import { existsSync, appendFileSync, writeFileSync } from 'node:fs'
      import { createInterface } from 'node:readline'
      import {createServer} from 'node:http'
      const [log, auth, settingsFlag, settings, command] = process.argv.slice(2)
      if (settingsFlag !== '--settings' || JSON.parse(settings).modelProvider !== '') process.exit(12)
      if(process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_BASE_URL) process.exit(12)
      appendFileSync(log,command+'\n')
      if(command === 'models') {
        if(!existsSync(auth)){ console.error('Error: Please sign in to view available models.');process.exit(1) }
        console.log('gemini-4-neon-high     Gemini 4 Neon (High)')
      } else for await (const line of createInterface({input:process.stdin})) {
        const msg=JSON.parse(line); const reply=result=>console.log(JSON.stringify({jsonrpc:'2.0',id:msg.id,result}))
        if(msg.method==='initialize') reply({protocolVersion:1,authMethods:[{id:'oauth-personal'}]})
        else if(msg.method==='authenticate' && msg.params.methodId==='oauth-personal'){
          const callback = createServer((req,res) => {writeFileSync(auth,'ok');res.end('accepted');callback.close();reply({})})
          callback.listen(0, '127.0.0.1', () => writeFileSync(log+'.port',String(callback.address().port)))
        } else process.exit(4)
      }
    `,
    )
    vi.stubEnv('GEMINI_API_KEY', 'irrelevant-gateway-key')
    vi.stubEnv('GOOGLE_GEMINI_BASE_URL', 'http://irrelevant.invalid')
    const account = new AntigravityAccount(async () => ({
      command: process.execPath,
      prefix: [file, log, auth],
    }))
    try {
      expect(
        (await Promise.all([account.status(), account.status(true)])).map((x) => x.status),
      ).toEqual(['signed-out', 'signed-out'])
      expect(await readFile(log, 'utf8')).toBe('models\n')
      expect((await account.login()).status).toBe('signing-in')
      const port = async () => Number(await readFile(log + '.port', 'utf8'))
      await vi.waitFor(async () => expect(await port()).toBeGreaterThan(0))
      expect((await account.status(true)).status).toBe('signing-in')
      const first = await port()
      expect((await account.cancel()).status).toBe('signed-out')
      await expect(fetch('http://127.0.0.1:' + first)).rejects.toThrow()
      await rm(log + '.port')
      expect((await account.login()).status).toBe('signing-in')
      await vi.waitFor(async () => expect(await port()).toBeGreaterThan(0))
      expect((await account.status(true)).status).toBe('signing-in')
      expect(await (await fetch('http://127.0.0.1:' + (await port()))).text()).toBe('accepted')
      await vi.waitFor(
        async () => {
          expect(await account.status(true)).toEqual({
            status: 'ready',
            models: ['gemini-4-neon-high'],
            labels: { 'gemini-4-neon-high': 'Gemini 4 Neon (High)' },
          })
        },
        { timeout: 8000 },
      )
      expect((await readFile(log, 'utf8')).split('acp\n')).toHaveLength(3)
    } finally {
      await account.dispose()
      await rm(dir, { force: true, recursive: true })
    }
  })
})
