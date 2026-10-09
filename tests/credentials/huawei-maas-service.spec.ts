import { Context } from '@deepseek-ai/cordis'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HuaweiMaaSService } from '../../src/credentials/host/huawei-maas-service.ts'
import { KeyringError } from '../../src/credentials/contracts/windows-keyring.ts'

const backend = vi.hoisted(() => ({
  describe: vi.fn(),
  save: vi.fn(),
  clear: vi.fn(),
}))

vi.mock('../../src/credentials/host/windows-keyring.ts', () => ({
  describeHuaweiMaaSApiKey: backend.describe,
  setHuaweiMaaSApiKey: backend.save,
  deleteHuaweiMaaSApiKey: backend.clear,
}))

const presence = (configured: boolean) => ({
  configured,
  supported: true,
  available: true,
  source: 'windows-credential-manager' as const,
})

describe('Huawei key configuration service', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    backend.describe.mockResolvedValue(presence(false))
    backend.save.mockResolvedValue(undefined)
    backend.clear.mockResolvedValue(false)
  })

  it('returns credential presence after saving without echoing the submitted key', async () => {
    const service = new HuaweiMaaSService(new Context())
    const key = 'synthetic-service-test-key'
    backend.describe.mockResolvedValue(presence(true))
    const result = await service.saveKey(' ' + key + ' ')
    expect(backend.save).toHaveBeenCalledWith(key)
    expect(result).toMatchObject({ ok: true, status: { credential: presence(true) } })
    expect(JSON.stringify(result)).not.toContain(key)
    expect(await service.status()).toEqual({
      baseUrl: 'https://api.modelarts-maas.com/openai/v1',
      model: 'glm-5.2',
      credential: presence(true),
    })
  })

  it('keeps helper diagnostics containing a key out of remote error results', async () => {
    const service = new HuaweiMaaSService(new Context())
    const key = 'synthetic-sensitive-diagnostic'
    backend.save.mockRejectedValue(new Error('Helper failed with input ' + key))
    const result = await service.saveKey(key)
    expect(result).toMatchObject({ ok: false, failure: 'helper-failed' })
    expect(JSON.stringify(result)).not.toContain(key)
    expect(backend.clear).not.toHaveBeenCalled()
  })

  it('distinguishes an unavailable keyring from an absent credential without file fallback', async () => {
    const service = new HuaweiMaaSService(new Context())
    backend.save.mockRejectedValue(new KeyringError('helper-unavailable', 'Unavailable'))
    backend.describe.mockResolvedValue({
      ...presence(false),
      available: false,
      failure: 'helper-unavailable',
    })
    const result = await service.saveKey('synthetic-key')
    expect(result).toMatchObject({
      ok: false,
      failure: 'helper-unavailable',
      status: { credential: { configured: false, available: false } },
    })
    expect(backend.save).toHaveBeenCalledTimes(1)
    expect(backend.clear).not.toHaveBeenCalled()
  })

  it('rejects non-string input before passing it to credential storage', async () => {
    const service = new HuaweiMaaSService(new Context())
    expect(await service.saveKey(42 as unknown as string)).toMatchObject({
      ok: false,
      failure: 'invalid-value',
    })
    expect(backend.save).not.toHaveBeenCalled()
  })

  it('clearing an already absent key succeeds without returning a secret', async () => {
    const service = new HuaweiMaaSService(new Context())
    const result = await service.clearKey()
    expect(result).toMatchObject({ ok: true, status: { credential: { configured: false } } })
    expect(backend.clear).toHaveBeenCalledTimes(1)
    expect(backend.save).not.toHaveBeenCalled()
  })
})
