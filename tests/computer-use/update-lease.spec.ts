import { expect, it, vi } from 'vitest'
import {
  registerKimiCuClients,
  withKimiCuCall,
  withKimiCuUpdate,
} from '../../src/computer-use/host/update-lease.ts'

it('allows overlapping tool calls, drains idle clients for an upgrade and releases on install failure', async () => {
  const close = vi.fn(async () => {})
  const unregister = registerKimiCuClients(close)
  try {
    await withKimiCuCall(() =>
      withKimiCuCall(async () => {
        await expect(withKimiCuUpdate(async () => {})).rejects.toThrow('kimi-cu-busy')
        expect(close).not.toHaveBeenCalled()
      }),
    )
    await expect(
      withKimiCuUpdate(async () => {
        expect(close).toHaveBeenCalledOnce()
        await expect(withKimiCuCall(async () => {})).rejects.toThrow('KimiCU')
        throw Error('install failed')
      }),
    ).rejects.toThrow('install failed')
    await expect(withKimiCuCall(async () => 'ok')).resolves.toBe('ok')
  } finally {
    unregister()
  }
})
