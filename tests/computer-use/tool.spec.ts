import { describe, expect, it } from 'vitest'
import {
  assertKimiCuPermission,
  KIMI_CU_INSTALL_COMMAND,
  qualifyKimiCu,
} from '../../src/computer-use/host/kimi-cu'

describe('KimiCU WinCU qualification', () => {
  it('fails closed outside Windows x64', () => {
    const result = qualifyKimiCu({ platform: 'darwin', arch: 'arm64' })
    expect(result.callable).toBe(false)
    expect(result.tools).toEqual([])
    expect(result.installCommand).toBe(KIMI_CU_INSTALL_COMMAND)
    expect(result.reason).toContain('Windows')
  })

  it('does not invent a callable protocol on Windows', () => {
    const result = qualifyKimiCu({ platform: 'win32', arch: 'x64', windowsRelease: '10.0.19045' })
    expect(result.status).toBe('unavailable')
    expect(result.callable).toBe(false)
    expect(result.pluginInstalled).toBe(false)
  })

  it('recognizes the documented Windows 10 1903 build floor', () => {
    const supported = qualifyKimiCu({
      platform: 'win32',
      arch: 'x64',
      windowsRelease: '10.0.18362',
    })
    const old = qualifyKimiCu({ platform: 'win32', arch: 'x64', windowsRelease: '10.0.17763' })
    expect(supported.supportedWindowsVersion).toBe(true)
    expect(old.supportedWindowsVersion).toBe(false)
  })

  it('requires explicit permission', () => {
    expect(() => assertKimiCuPermission(false)).toThrow('explicit computer-use permission')
    expect(() => assertKimiCuPermission(true)).not.toThrow()
  })
})
