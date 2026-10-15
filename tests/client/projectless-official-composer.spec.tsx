import { memo, type ReactElement } from 'react'
import { describe, expect, it } from 'vitest'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import type { ComposerBarProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { installProjectlessOfficialComposer } from '../../src/execution/client/ProjectlessOfficialComposer.tsx'
import { markProjectlessSession } from '../../src/execution/client/fresh-session.ts'

function fixture() {
  const core = new SlotCore()
  core.register(
    {
      name: 'root',
      children: {
        'conversation.composer.bar': { kind: 'single', scope: 'session-maybe' },
      },
    },
    () => null,
  )
  const original = memo(() => null)
  const entries = () => core.entries('conversation.composer.bar')
  const install = () =>
    installProjectlessOfficialComposer(entries, (listener) =>
      core.subscribe('conversation.composer.bar', listener),
    )
  const register = () =>
    core.register(
      {
        name: 'conversation.composer.bar',
        children: {
          'conversation.input.right': { kind: 'list', scope: 'session' },
        },
      },
      original,
    )
  return { core, original, entries, install, register }
}

function render(f: ReturnType<typeof fixture>, props: Partial<ComposerBarProps>) {
  const component = f.entries()[0]!.component as (props: ComposerBarProps) => ReactElement
  return component(props as ComposerBarProps)
}

describe('official projectless composer adapter', () => {
  it('preserves the official memo component and its existing child declaration', () => {
    const f = fixture()
    f.register()
    const entry = f.entries()[0]!
    const dispose = f.install()
    const id = 'session-projectless-official-test'
    markProjectlessSession(id)
    const element = render(f, {
      sessionId: id as never,
      variant: 'hero',
      disabled: true,
      onRequestWorkspace: () => {},
      placeholder: 'workspace',
      blocked: { reason: 'busy' },
    })
    expect(element.type).toBe(f.original)
    expect(element.props.disabled).toBe(false)
    expect(element.props.onRequestWorkspace).toBeUndefined()
    expect(element.props.placeholder).toBeUndefined()
    expect(element.props.blocked).toEqual({ reason: 'busy' })
    expect(f.entries()).toEqual([entry])
    expect(f.core.spec('conversation.input.right')).toBeDefined()
    dispose()
    expect(entry.component).toBe(f.original)
  })

  it('waits for the official entry when the declaration precedes registration', async () => {
    const f = fixture()
    const dispose = f.install()
    f.register()
    await Promise.resolve()
    expect(f.entries()[0]!.component).not.toBe(f.original)
    dispose()
    expect(f.entries()[0]!.component).toBe(f.original)
  })

  it('preserves ordinary workspace locks and unrelated projectless restrictions', () => {
    const f = fixture()
    f.register()
    const dispose = f.install()
    const regular = { variant: 'hero' as const, disabled: true, onRequestWorkspace: () => {} }
    expect(render(f, regular).props).toEqual(regular)
    const id = 'session-projectless-restricted'
    markProjectlessSession(id)
    const restricted = { sessionId: id as never, variant: 'composer' as const, disabled: true }
    expect(render(f, restricted).props).toEqual(restricted)
    dispose()
  })

  it('restores an unloaded entry and decorates its replacement', async () => {
    const f = fixture()
    const unregister = f.register()
    const first = f.entries()[0]!
    const dispose = f.install()
    unregister()
    f.register()
    await Promise.resolve()
    expect(first.component).toBe(f.original)
    expect(f.entries()[0]!.component).not.toBe(f.original)
    dispose()
  })
})
