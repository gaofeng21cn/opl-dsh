import { describe, expect, it } from 'vitest'
import { RuntimeMaintenance } from '../../src/execution/host/runtime-maintenance.ts'

function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('runtime maintenance admission', () => {
  it('refuses a switch while an admission has not published its running state', async () => {
    const gate = new RuntimeMaintenance(),
      pending = barrier()
    const admission = gate.admit(() => pending.promise)
    await expect(
      gate.change(
        () => false,
        async () => 'switched',
      ),
    ).rejects.toThrow('启动请求')
    pending.resolve()
    await admission
    expect(
      await gate.change(
        () => false,
        async () => 'switched',
      ),
    ).toBe('switched')
  })
  it('excludes admissions and model requests across asynchronous catalog publication', async () => {
    const gate = new RuntimeMaintenance(),
      pending = barrier()
    const change = gate.change(
      () => false,
      () => pending.promise,
    )
    expect(() => gate.assertAvailable()).toThrow('切换')
    await expect(gate.admit(async () => 'launched')).rejects.toThrow('切换')
    await expect(
      gate.change(
        () => false,
        async () => 'second',
      ),
    ).rejects.toThrow('切换')
    pending.resolve()
    await change
    expect(await gate.admit(async () => 'launched')).toBe('launched')
  })
  it('refuses existing work and releases exclusion when publication fails', async () => {
    const gate = new RuntimeMaintenance()
    await expect(
      gate.change(
        () => true,
        async () => 'switched',
      ),
    ).rejects.toThrow('活动任务')
    await expect(
      gate.change(
        () => false,
        async () => {
          throw Error('disk failure')
        },
      ),
    ).rejects.toThrow('disk failure')
    expect(await gate.admit(async () => 'old runtime usable')).toBe('old runtime usable')
  })
  it('drains publication on disposal and never reopens admission', async () => {
    const gate = new RuntimeMaintenance(),
      pending = barrier()
    const change = gate.change(
      () => false,
      () => pending.promise,
    )
    let closed = false
    const closing = gate.close().then(() => {
      closed = true
    })
    await Promise.resolve()
    expect(closed).toBe(false)
    await expect(gate.admit(async () => 'launched')).rejects.toThrow('已关闭')
    pending.resolve()
    await change
    await closing
    expect(closed).toBe(true)
    expect(() => gate.assertAvailable()).toThrow('已关闭')
  })
})
