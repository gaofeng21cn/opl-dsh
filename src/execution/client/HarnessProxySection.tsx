import { useRef } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HarnessDefinition } from '../contracts/catalog.ts'
import { defaultExecutionT, type ExecutionSettingsT } from './execution-settings-locales.ts'
import {
  PROXY_EXAMPLE,
  proxyDraftError,
  type ProxyDraft,
  type ProxyMode,
  type ProxyOutcome,
} from './proxy-draft.ts'
import css from '../../shared/client/SettingsSection.module.css'
/** One row's edit, one row's save; both addressed by Harness id. */
export type ProxyEdit = (id: string, patch: Partial<ProxyDraft>) => void
/**
 * The override carries the address still sitting in the box. The draft state is
 * written asynchronously, so saving needs the typed value passed in rather than
 * read back from the state this click has just invalidated.
 */
export type ProxySubmit = (id: string, override?: Partial<ProxyDraft>) => void

/**
 * A network preference inside the existing Harness card, with one draft per engine.
 *
 * A row is edited in place and only reaches the catalog when its own 保存代理 is
 * pressed, so one Harness's proxy cannot be changed by touching another's. The
 * built-in DSH Harness runs inside the desktop process and its model traffic uses
 * the desktop's own network stack, so its row is shown but cannot be set: leaving it
 * out would leave a reader wondering where the setting for that Harness went.
 */
export function HarnessProxySection({
  harness,
  drafts,
  errors,
  outcome,
  busy,
  onEdit,
  onSave,
  onReset,
  t = defaultExecutionT,
}: {
  harness: HarnessDefinition
  drafts: Record<string, ProxyDraft>
  errors: Record<string, string>
  outcome?: ProxyOutcome | undefined
  busy: boolean
  onEdit: ProxyEdit
  onSave: ProxySubmit
  onReset: (id: string) => void
  t?: ExecutionSettingsT
}) {
  const inputs = useRef(new Map<string, HTMLInputElement>())
  const modes: { mode: ProxyMode; label: string; hint: string }[] = [
    { mode: 'inherit', label: t('proxyModeInherit'), hint: t('proxyModeInheritHint') },
    { mode: 'direct', label: t('proxyModeDirect'), hint: t('proxyModeDirectHint') },
    {
      mode: 'custom',
      label: t('proxyModeCustom'),
      hint: t('proxyModeCustomHint', { example: PROXY_EXAMPLE }),
    },
  ]
  /**
   * The address box is uncontrolled: it owns what the user typed, and the draft is
   * brought up to date from the box at the points where the value is actually needed —
   * on blur, when the mode changes, and when 保存代理 is pressed.
   */
  const readUrl = (id: string) => inputs.current.get(id)?.value ?? ''
  const builtIn = harness.kind === 'dsh'
  const stored = harness.proxy
  const draft = drafts[harness.id] ?? { mode: 'inherit' as const, url: '' }
  const error = errors[harness.id] || proxyDraftError(draft, t)
  const message = outcome?.id === harness.id ? outcome.message : ''
  const dirty =
    draft.mode !== (stored?.mode ?? 'inherit') ||
    (draft.mode === 'custom' && draft.url !== (stored?.mode === 'custom' ? stored.url : ''))
  const pick = (mode: ProxyMode) => {
    // Carry the typed address across the switch, so coming back to 指定代理
    // restores it instead of asking for the same URL a second time.
    const typed = draft.mode === 'custom' ? readUrl(harness.id) || draft.url : draft.url
    onEdit(harness.id, { mode, url: typed })
  }
  const activeModeLabel = modes.find((item) => item.mode === draft.mode)?.label ?? ''
  return (
    <details className={css.details} data-opl-proxy-row={harness.id} aria-busy={busy}>
      <summary>{t('proxySummary', { mode: activeModeLabel })}</summary>
      <div className={css.detailsBody}>
        <p className={css.muted}>{t('proxyIntro')}</p>
        {builtIn && <p className={css.muted}>{t('proxyBuiltInNote')}</p>}
        <div
          className={css.proxyModes}
          role="radiogroup"
          aria-label={t('proxyRadioGroupLabel', { name: harness.name })}
        >
          {modes.map((item) => (
            <label className={css.proxyMode} key={item.mode}>
              <input
                type="radio"
                name={`opl-harness-proxy-${harness.id}`}
                value={item.mode}
                checked={draft.mode === item.mode}
                disabled={builtIn || busy}
                onChange={() => pick(item.mode)}
              />
              {item.label}
            </label>
          ))}
        </div>
        {draft.mode === 'custom' && !builtIn && (
          <label className={css.field}>
            {t('proxyUrlLabel')}
            <input
              className={css.input}
              type="text"
              inputMode="url"
              placeholder={PROXY_EXAMPLE}
              defaultValue={draft.url}
              disabled={busy}
              aria-invalid={error ? 'true' : undefined}
              aria-describedby={error ? `opl-proxy-error-${harness.id}` : undefined}
              data-opl-proxy-url={harness.id}
              onChange={(event) => onEdit(harness.id, { url: event.target.value })}
              onBlur={() => onEdit(harness.id, { url: readUrl(harness.id) })}
              ref={(element) => {
                if (element) inputs.current.set(harness.id, element)
                else inputs.current.delete(harness.id)
              }}
            />
            <span className={css.muted}>{modes[2].hint}</span>
          </label>
        )}
        {error && (
          <p
            className={css.error}
            role="alert"
            id={`opl-proxy-error-${harness.id}`}
            data-opl-proxy-error={harness.id}
          >
            {error}
          </p>
        )}
        {message && (
          <p
            className={outcome?.ok ? css.notice : css.error}
            role={outcome?.ok ? 'status' : 'alert'}
            data-opl-proxy-outcome={harness.id}
          >
            {message}
          </p>
        )}
        {!builtIn && (
          <div className={css.actions}>
            <Button
              aria-label={t('proxySaveAriaLabel', { name: harness.name })}
              data-opl-proxy-save={harness.id}
              disabled={busy}
              onClick={() => {
                const typed = { url: draft.mode === 'custom' ? readUrl(harness.id) : draft.url }
                onEdit(harness.id, typed)
                onSave(harness.id, typed)
              }}
            >
              {t('proxySaveButton')}
            </Button>
            {dirty && (
              <Button
                aria-label={t('proxyResetAriaLabel', { name: harness.name })}
                data-opl-proxy-reset={harness.id}
                disabled={busy}
                onClick={() => {
                  onReset(harness.id)
                  const input = inputs.current.get(harness.id)
                  if (input) input.value = stored?.mode === 'custom' ? stored.url : ''
                }}
              >
                {t('proxyResetButton')}
              </Button>
            )}
          </div>
        )}
      </div>
    </details>
  )
}
