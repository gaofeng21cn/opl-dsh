import { expect, it, vi } from 'vitest'
import { PendingCombination } from '../../src/execution/client/pending-combination.ts'

it('sends once after the selected combination is bound, without delaying another session', async () => {
  const picker = new PendingCombination()
  const write = Promise.withResolvers<void>()
  const selecting = picker.select('one', () => write.promise)
  const submit = vi.fn(async () => 'sent')
  const sending = picker.send('one', undefined, submit)
  expect(await picker.send('two', undefined, async () => 'other')).toBe('other')
  expect(submit).not.toHaveBeenCalled()
  write.resolve()
  await selecting
  expect(await sending).toBe('sent')
  expect(submit).toHaveBeenCalledTimes(1)
})

it('does not submit on failed selection or after a waiting send was cancelled', async () => {
  for (const aborted of [false, true]) {
    const picker = new PendingCombination()
    const write = Promise.withResolvers<void>()
    const selecting = picker.select('one', () => write.promise)
    const abort = new AbortController()
    const submit = vi.fn(async () => 'sent')
    const sending = picker.send('one', abort.signal, submit)
    if (aborted) {
      abort.abort()
      write.resolve()
    } else write.reject(Error('model unavailable'))
    await Promise.allSettled([selecting])
    await expect(sending).rejects.toThrow()
    expect(submit).not.toHaveBeenCalled()
  }
})

it('cancels a waiting send before the picker write finishes', async () => {
  const picker = new PendingCombination()
  const write = Promise.withResolvers<void>()
  const selecting = picker.select('one', () => write.promise)
  const abort = new AbortController()
  const submit = vi.fn(async () => 'sent')
  const sending = picker.send('one', abort.signal, submit)
  const cancellation = Error('cancelled')
  abort.abort(cancellation)
  try {
    const nextTask = new Promise<void>((resolve) => setTimeout(resolve, 0))
    await expect(Promise.race([sending, nextTask])).rejects.toBe(cancellation)
  } finally {
    write.resolve()
    await selecting
    await Promise.allSettled([sending])
  }
  expect(submit).not.toHaveBeenCalled()
})

it('blocks a delayed attachment send after a failed switch until a selection is confirmed', async () => {
  const picker = new PendingCombination()
  const send = vi.fn(async () => 'sent')
  await expect(
    picker.select('one', async () => {
      throw Error('offline')
    }),
  ).rejects.toThrow()
  await expect(picker.send('one', undefined, send)).rejects.toThrow()
  expect(send).not.toHaveBeenCalled()
  await picker.select('one', async () => 'confirmed')
  expect(await picker.send('one', undefined, send)).toBe('sent')
})
