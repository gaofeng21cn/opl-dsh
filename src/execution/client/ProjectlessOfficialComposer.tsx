import { createElement } from 'react'
import type { ComponentType } from 'react'
import type { ComposerBarProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { isProjectlessSession } from './fresh-session.ts'

type ResidentComposerProps = ComposerBarProps & { readonly sessionId?: string }

/**
 * Decorate the resident official bar while preserving its registration, injected
 * editor operations, child-slot ownership, and React memo component.
 * The slot inspection API exposes the live entry. Restore only our component
 * when its owner or this plugin unloads; do not register its child slots twice.
 * @param entries - current official composer registrations.
 * @param subscribe - official registration-change subscription.
 * @returns disposer restoring the resident component.
 */
export function installProjectlessOfficialComposer(
  entries: () => readonly StoredEntry[],
  subscribe: (listener: () => void) => () => void,
): () => void {
  let restore = () => {}
  let current: StoredEntry | undefined
  const reconcile = () => {
    const entry = entries()[0]
    if (entry === current) return
    restore()
    current = entry
    if (entry === undefined) return
    const original = entry.component
    const component = original as ComponentType<ResidentComposerProps>
    const decorated = (props: ResidentComposerProps) => {
      const projectless = props.sessionId !== undefined && isProjectlessSession(props.sessionId)
      const workspaceLock =
        projectless && props.disabled === true && props.onRequestWorkspace !== undefined
      if (!workspaceLock) return createElement(component, props)
      const { onRequestWorkspace: _request, placeholder: _placeholder, ...unlocked } = props
      return createElement(component, { ...unlocked, disabled: false, workspacePickerOpen: false })
    }
    entry.component = decorated
    restore = () => {
      if (entry.component === decorated) entry.component = original
    }
  }
  const off = subscribe(reconcile)
  reconcile()
  return () => {
    off()
    restore()
  }
}
