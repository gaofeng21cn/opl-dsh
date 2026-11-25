import { describe, expect, it } from 'vitest'
import { parseCodexWslDistros, prepareCodexWsl } from '../../src/gateway/host/codex-wsl.ts'

describe('Codex WSL targets', () => {
  it('shows registered user distributions once, including spaces, without internal VMs or options', () => {
    const names =
      '\ufeffUbuntu\r\nDebian QA\r\nUbuntu\r\ndocker-desktop\r\ndocker-desktop-data\r\nrancher-desktop\r\npodman-machine-default\r\n--user root\r\nBad & Name\r\n'
    expect(parseCodexWslDistros(Buffer.from(names, 'utf16le'))).toEqual(['Ubuntu', 'Debian QA'])
    expect(parseCodexWslDistros(Buffer.from('Debian\n'))).toEqual(['Debian'])
  })
  it('refuses an unregistered distro before any requested install', async () => {
    await expect(prepareCodexWsl('--exec /bin/sh', true)).rejects.toMatchObject({
      code: 'WSL_CODEX_SETUP_FAILED',
    })
  })
})
