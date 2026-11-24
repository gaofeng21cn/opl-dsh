import { googleTier } from './google-account-choices.ts'
import { useEffect, useRef, useState } from 'react'
import type { AntigravityAccountStatus } from '../contracts/antigravity-account.ts'
import rows from './CombinationRows.module.css'
import provider from './MiniMaxIntegration.module.css'
import css from '../../shared/client/SettingsSection.module.css'

export const antigravityAccountZh = {
  title: 'Google 账号（Antigravity CLI）',
  edit: '编辑',
  reading: '正在读取账号状态…',
  ready: '账号可用',
  'signed-out': '未登录',
  'signing-in': '等待网页授权',
  unknown: '无法确认账号状态',
  unavailable: '未找到 Antigravity CLI',
  installHint: '请先在“执行与组合”的执行引擎中安装 Antigravity CLI。',
  intro: '使用 Google 账号的 Antigravity 模型和额度。',
  login: '使用 Google 账号登录',
  refresh: '刷新状态',
  opened: '请在浏览器中完成 Google 登录。若网页无法返回，可取消后重新登录。',
  cancel: '取消本次登录',
  cancelFailed: '未能取消本次登录，请刷新状态后重试。',
  failed: '无法启动官方登录，请检查 Antigravity CLI 的安装。',
  models: '账号可用模型',
} as const
type LocaleKey = keyof typeof antigravityAccountZh
export const antigravityAccountEn: Record<LocaleKey, string> = {
  title: 'Google account (Antigravity CLI)',
  edit: 'Edit',
  reading: 'Checking account…',
  ready: 'Account available',
  'signed-out': 'Signed out',
  'signing-in': 'Waiting for browser authorization',
  unknown: 'Unable to confirm account status',
  unavailable: 'Antigravity CLI not found',
  installHint: 'Install Antigravity CLI under Execution engines in Execution and combinations.',
  intro: 'Use the Antigravity models and quota available to your Google account.',
  login: 'Sign in with Google',
  refresh: 'Refresh status',
  opened:
    'Finish signing in with Google in your browser. If it cannot return, cancel and sign in again.',
  cancel: 'Cancel sign-in',
  cancelFailed: 'Could not cancel sign-in. Refresh the status and try again.',
  failed: 'Could not start sign-in. Check your Antigravity CLI installation.',
  models: 'Available account models',
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.antigravityAccount': LocaleKey
  }
}
type AccountProps = {
  t: (key: LocaleKey) => string
  read: () => Promise<AntigravityAccountStatus>
  login: () => Promise<AntigravityAccountStatus>
  cancel: () => Promise<AntigravityAccountStatus>
}

/** The provider card runs the CLI status probe only when the user opens its settings. */
export function AntigravityAccountCard({ t, read, login, cancel }: AccountProps) {
  const [editing, setEditing] = useState(false)
  return (
    <section className={`${css.card} ${provider.card}`} data-opl-panel="antigravity-account">
      <div className={css.header}>
        <span className={css.name}>{t('title')}</span>
        <button
          type="button"
          className={provider.editButton}
          aria-expanded={editing}
          aria-label={t('edit') + ' ' + t('title')}
          onClick={() => setEditing(!editing)}
        >
          {t('edit')}
        </button>
      </div>
      {editing && <AccountEditor t={t} read={read} login={login} cancel={cancel} />}
    </section>
  )
}

function AccountModels({ state, title }: { state: AntigravityAccountStatus; title: string }) {
  const groups = new Map<string, { name: string; levels: string[]; ids: string[] }>()
  for (const id of state.models) {
    const label = state.labels?.[id] ?? id
    const tier = googleTier(id, label)
    const key = tier?.key ?? id
    const row = groups.get(key) ?? { name: tier?.name ?? label, levels: [], ids: [] }
    row.ids.push(id)
    if (tier) row.levels.push(tier.level)
    groups.set(key, row)
  }
  return (
    <details className={css.details}>
      <summary>
        {title}（{groups.size}）
      </summary>
      <div className={rows.discoveryList} role="list">
        {[...groups].map(([key, row]) => (
          <div key={key} className={rows.discoveryRow} role="listitem" title={row.ids.join(', ')}>
            <span className={rows.discoveryName}>{row.name}</span>
            {row.levels.length > 0 && (
              <span className={rows.discoveryStatus}>{row.levels.join(' / ')}</span>
            )}
          </div>
        ))}
      </div>
    </details>
  )
}

function AccountEditor({ t, read, login, cancel }: AccountProps) {
  const [state, setState] = useState<AntigravityAccountStatus>()
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const revision = useRef(0)
  const [notice, setNotice] = useState<'failed' | 'cancelFailed'>()
  useEffect(() => {
    const id = ++revision.current
    void read().then(
      (next) => {
        if (id === revision.current) setState(next)
      },
      () => {
        if (id === revision.current) setState({ status: 'unknown', models: [] })
      },
    )
    return () => {
      ++revision.current
    }
  }, [read])

  const pending = state?.status === 'signing-in'
  useEffect(() => {
    if (!pending || busy) return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      const id = revision.current
      try {
        const next = await read()
        if (!active || id !== revision.current) return
        setState(next)
        if (next.status !== 'signing-in') return
      } catch {
        // A transient RPC failure leaves the current authorization available to cancel.
      }
      if (active && id === revision.current) timer = setTimeout(poll, 2000)
    }
    timer = setTimeout(poll, 2000)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [pending, read, busy])

  async function run(action: 'login' | 'cancel' | 'refresh') {
    if (lock.current) return
    lock.current = true
    const id = ++revision.current
    setBusy(true)
    setNotice(undefined)
    try {
      const next = await { login, cancel, refresh: read }[action]()
      if (id === revision.current) setState(next)
    } catch {
      if (id !== revision.current) return
      if (action === 'refresh') {
        if (!pending) setState({ status: 'unknown', models: [] })
      } else {
        setNotice(action === 'login' ? 'failed' : 'cancelFailed')
      }
    } finally {
      lock.current = false
      if (id === revision.current) setBusy(false)
    }
  }
  return (
    <div className={provider.editor}>
      <p className={css.muted}>{t('intro')}</p>
      <div className={css.row}>
        <span className={css.name} role="status">
          {t(state?.status ?? 'reading')}
        </span>
        <button
          className={provider.editButton}
          type="button"
          disabled={!state || busy}
          onClick={() => void run('refresh')}
        >
          {t('refresh')}
        </button>
        {pending && (
          <button
            type="button"
            className={provider.editButton}
            disabled={busy}
            onClick={() => void run('cancel')}
          >
            {t('cancel')}
          </button>
        )}
        {state && (state.status === 'signed-out' || state.status === 'unknown') && (
          <button
            className={provider.editButton}
            type="button"
            disabled={busy}
            onClick={() => void run('login')}
          >
            {t('login')}
          </button>
        )}
      </div>
      {state?.status === 'unavailable' && <p className={css.muted}>{t('installHint')}</p>}
      {state?.status === 'signing-in' && <p className={css.muted}>{t('opened')}</p>}
      {notice && (
        <p className={css.error} role="status">
          {t(notice)}
        </p>
      )}
      {state?.status === 'ready' && state.models.length > 0 && (
        <AccountModels state={state} title={t('models')} />
      )}
    </div>
  )
}
