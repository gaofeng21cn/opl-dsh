import { expect, it, vi } from 'vitest'
import { installGoogleAccountChoices } from '../../src/execution/client/google-account-choices.ts'
import { installEffortDirectories } from '../../src/execution/client/official-effort-directory.ts'
import { ANTIGRAVITY_GOOGLE_PROVIDER as provider } from '../../src/shared/models.ts'

it('projects an account model family and sends its exact advertised ID when the tier changes', async () => {
  const models = ['low', 'high'].map((tier) => ({
    id: 'gemini-test-' + tier,
    name: 'Gemini Test (' + (tier === 'low' ? 'Low' : 'High') + ')',
  }))
  const state = {
    current: { provider, model: models[0]!.id },
    groups: [{ id: provider, name: 'Google', models }],
  }
  const select = vi.fn()
  const directory = {
    store: { getSnapshot: () => state, subscribe: () => () => {} },
    select,
    load: async () => state,
  }
  const owner = { directoryFor: (_id: string) => directory }
  const original = owner.directoryFor
  const remote = vi.fn()
  const restoreEfforts = installEffortDirectories(
    owner as Parameters<typeof installEffortDirectories>[0],
    remote,
    new EventTarget(),
  )
  const dispose = installGoogleAccountChoices(
    owner as Parameters<typeof installGoogleAccountChoices>[0],
  )
  const wrapped = owner.directoryFor('session')
  await wrapped.load()
  expect(wrapped.store.getSnapshot().groups[0]!.models).toMatchObject([
    {
      name: 'Gemini Test',
      reasoning: { defaultEffort: 'low', efforts: [{ id: 'low' }, { id: 'high' }] },
    },
  ])
  await wrapped.select({ ...state.current, reasoningEffort: 'high' })
  expect(select).toHaveBeenCalledExactlyOnceWith({ provider, model: 'gemini-test-high' })
  expect(remote).not.toHaveBeenCalled()
  dispose()
  restoreEfforts()
  expect(owner.directoryFor).toBe(original)
})
