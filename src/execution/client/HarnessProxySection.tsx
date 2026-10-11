import { useRef } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HarnessDefinition } from '../contracts/catalog.ts'
import {
  PROXY_EXAMPLE,
  proxyDraftError,
  type ProxyDraft,
  type ProxyMode,
  type ProxyOutcome,
} from './use-execution-catalog.ts'
import css from '../../shared/client/SettingsSection.module.css'
/** One row's edit, one row's save; both addressed by Harness id. */
export type ProxyEdit = (id: string, patch: Partial<ProxyDraft>) => void
/**
 * The override carries the address still sitting in the box. The draft state is
 * written asynchronously, so saving needs the typed value passed in rather than
 * read back from the state this click has just invalidated.
 */
export type ProxySubmit = (id: string, override?: Partial<ProxyDraft>) => void
const MODES: { mode: ProxyMode; label: string; hint: string }[] = [
  { mode: 'inherit', label: '继承环境', hint: '沿用桌面进程的环境变量，不额外改写' },
  { mode: 'direct', label: '直连', hint: '清空该 CLI 的代理变量，让它直接联网' },
  { mode: 'custom', label: '指定代理', hint: `只为此 CLI 设置，例如 ${PROXY_EXAMPLE}` },
]
/**
 * Per-Harness network proxy, one independent draft per row.
 *
 * A row is edited in place and only reaches the catalog when its own 保存代理 is
 * pressed, so one Harness's proxy cannot be changed by touching another's. The
 * built-in DSH Harness runs inside the desktop process and its model traffic uses
 * the desktop's own network stack, so its row is shown but cannot be set: leaving it
 * out would leave a reader wondering where the setting for that Harness went.
 */
export function HarnessProxySection({
  harnesses,
  drafts,
  errors,
  outcome,
  busy,
  onEdit,
  onSave,
  onReset,
}: {
  harnesses: HarnessDefinition[]
  drafts: Record<string, ProxyDraft>
  errors: Record<string, string>
  outcome?: ProxyOutcome | undefined
  busy: boolean
  onEdit: ProxyEdit
  onSave: ProxySubmit
  onReset: (id: string) => void
}) {
  const inputs = useRef(new Map<string, HTMLInputElement>())
  /**
   * The address box is uncontrolled: it owns what the user typed, and the draft is
   * brought up to date from the box at the points where the value is actually needed —
   * on blur, when the mode changes, and when 保存代理 is pressed.
   */
  const readUrl = (id: string) => inputs.current.get(id)?.value ?? ''
  if (harnesses.length === 0) return null
  return (
    <section className={css.details} data-opl-panel="harness-proxy">
      <h3 className={css.title}>外部 Harness 网络代理</h3>
      <p className={css.intro}>
        为每个外部 Harness
        单独设置它启动子进程时使用的网络代理。每一项先在本地修改，再各自保存；其它
        Harness、模型和运行配置不受影响。保存后，正在运行的任务保持当前连接，后续轮次重连时才会使用新设置。
      </p>
      {harnesses.map((harness) => {
        const builtIn = harness.kind === 'dsh'
        const stored = harness.proxy
        const draft = drafts[harness.id] ?? { mode: 'inherit' as const, url: '' }
        const error = errors[harness.id] || proxyDraftError(draft)
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
        return (
          <div
            className={css.card}
            key={harness.id}
            data-opl-proxy-row={harness.id}
            aria-busy={busy}
          >
            <div className={css.header}>
              <div className={css.identity}>
                <strong>{harness.name}</strong>
                <span className={css.muted}>
                  {builtIn ? '内置 Harness' : harness.command || '外部 CLI'}
                </span>
              </div>
              <span className={css.muted}>
                {MODES.find((item) => item.mode === draft.mode)?.label}
              </span>
            </div>
            {builtIn && (
              <p className={css.muted}>
                内置 DSH 与桌面同进程运行，模型请求由 DSH
                自身的网络栈发出，不经过这个子进程代理选项；只有外部 CLI 使用它。
              </p>
            )}
            <div className={css.facts} role="radiogroup" aria-label={`${harness.name} 的网络代理`}>
              {MODES.map((item) => (
                <label className={css.label} key={item.mode}>
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
                代理地址
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
                <span className={css.muted}>{MODES[2].hint}</span>
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
                  aria-label={`保存 ${harness.name} 的代理设置`}
                  data-opl-proxy-save={harness.id}
                  disabled={busy}
                  onClick={() => {
                    const typed = { url: draft.mode === 'custom' ? readUrl(harness.id) : draft.url }
                    onEdit(harness.id, typed)
                    onSave(harness.id, typed)
                  }}
                >
                  保存代理
                </Button>
                {dirty && (
                  <Button
                    aria-label={`放弃 ${harness.name} 的代理修改`}
                    data-opl-proxy-reset={harness.id}
                    disabled={busy}
                    onClick={() => {
                      onReset(harness.id)
                      const input = inputs.current.get(harness.id)
                      if (input) input.value = stored?.mode === 'custom' ? stored.url : ''
                    }}
                  >
                    放弃修改
                  </Button>
                )}
              </div>
            )}
          </div>
        )
      })}
    </section>
  )
}
