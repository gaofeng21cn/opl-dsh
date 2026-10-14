import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-permission-presets'

const SETTINGS_NS = 'opl-suite'
const PERMISSION_PRESETS = new Set(['read-only', 'workspace-write', 'danger-full-access'])
type RememberedPreset = 'read-only' | 'workspace-write' | 'danger-full-access'

function rememberedPreset(ctx: Context): RememberedPreset | undefined {
  const value = ctx.settings
    .describe({ redactSecrets: true })
    .find((item) => item.ns === SETTINGS_NS)?.value
  if (!value || typeof value !== 'object' || !('lastPermissionPreset' in value)) return
  const candidate = value.lastPermissionPreset
  return typeof candidate === 'string' && PERMISSION_PRESETS.has(candidate)
    ? (candidate as RememberedPreset)
    : undefined
}

function presetFrom(event: SessionEvent): RememberedPreset | undefined {
  if (event.type !== 'permission/preset') return
  const candidate = event.data.preset
  return typeof candidate === 'string' && PERMISSION_PRESETS.has(candidate)
    ? (candidate as RememberedPreset)
    : undefined
}

/**
 * Keep the last explicit built-in permission choice as the default for future native Sessions.
 * Seeded sessions and initial permission pinning are ignored so external Harness records cannot
 * inherit a user's later native-chat choice.
 * @param ctx - Official Host context containing settings, Sessions, and permission presets.
 * @returns disposer for the event observers.
 */
export function installPermissionMemory(ctx: Context): () => void {
  const known = new Set<string>()
  for (const session of ctx.sessions.list()) known.add(session.id)
  let writes = Promise.resolve()

  const persist = (preset: RememberedPreset) => {
    writes = writes
      .then(async () => {
        const descriptor = ctx.settings.describe().find((item) => item.ns === SETTINGS_NS)
        if (!descriptor) return
        const current = rememberedPreset(ctx)
        if (current === preset) return
        await ctx.settings.mutate(
          SETTINGS_NS,
          [{ op: 'set', path: ['lastPermissionPreset'], value: preset }],
          descriptor.revision,
        )
      })
      .catch((error) => {
        ctx.logger.warn(
          `permission memory update failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
  }

  const disposeCreated = ctx.on('session/created', (session) => {
    const fresh = !known.has(session.id)
    known.add(session.id)
    if (!fresh || session.snapshotEvents().length > 1) return
    const preset = rememberedPreset(ctx)
    if (!preset || ctx.permissionPresets.current(session) === preset) return
    ctx.permissionPresets.set(session, preset)
  })
  const disposeEvent = ctx.on('session/event', (session, event) => {
    if (!known.has(session.id)) return
    const preset = presetFrom(event)
    if (preset) persist(preset)
  })
  const disposeDisposed = ctx.on('session/disposed', (session) => {
    known.delete(session.id)
  })
  return () => {
    disposeCreated()
    disposeEvent()
    disposeDisposed()
  }
}
