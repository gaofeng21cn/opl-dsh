import { afterEach, expect, it, vi } from 'vitest'
import { FIXED_WINDOW_TITLE, installFixedWindowTitle } from '../../src/window-title/client/title.ts'

vi.mock('../../src/window-title/client/FixedWindowTitleRow.tsx', () => ({ FixedWindowTitleRow: () => null }))

import { apply } from '../../src/window-title/client/index.tsx'

afterEach(() => vi.unstubAllGlobals())

it('keeps the renderer title fixed and restores the prior title when disabled', () => {
  vi.stubGlobal('MutationObserver', undefined)
  const documentLike = { title: 'A conversation', head: {} } as unknown as Document
  const title = installFixedWindowTitle(documentLike, true)

  expect(documentLike.title).toBe(FIXED_WINDOW_TITLE)
  title.setEnabled(false)
  expect(documentLike.title).toBe('A conversation')
  title.setEnabled(true)
  expect(documentLike.title).toBe(FIXED_WINDOW_TITLE)
  title.dispose()
  expect(documentLike.title).toBe('A conversation')
})

it.each(['MacIntel', 'Linux x86_64'])('leaves the title and settings to the desktop on %s', (platform) => {
  vi.stubGlobal('navigator', { platform })
  const documentLike = { title: 'Conversation' }
  vi.stubGlobal('document', documentLike)
  const effect = vi.fn()
  apply({ effect } as unknown as Parameters<typeof apply>[0])
  expect(effect).not.toHaveBeenCalled()
  expect(documentLike.title).toBe('Conversation')
})
