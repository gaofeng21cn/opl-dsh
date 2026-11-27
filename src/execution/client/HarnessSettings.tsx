import { EngineUpdates } from './EngineUpdates.tsx'
import { useHarnessSettings } from './use-harness-settings.ts'
import { ExecutableBrowser } from '../../shared/client/ExecutableBrowser.tsx'
import { HarnessProxySection } from './HarnessProxySection.tsx'
import {
  Button,
  IconChevronRightOutlineRegular,
  StateDot,
  type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { HarnessInstallation } from '../../contracts/types.ts'
import { isPrimaryHarness } from '../contracts/harness-groups.ts'
import css from '../../shared/client/SettingsSection.module.css'
import rowCss from './HarnessSettings.module.css'
import type { ExecutionCall as Call } from '../../shared/client/remote-call.ts'
import { defaultExecutionT, type ExecutionSettingsT } from './execution-settings-locales.ts'

function statusOf(
  item: HarnessInstallation,
  t: ExecutionSettingsT,
): { label: string; state: StateDotState } {
  if (item.id === 'dsh') return { label: t('statusBuiltIn'), state: 'done' }
  if (item.maintenance?.state === 'running') return { label: t('statusRunning'), state: 'ongoing' }
  if (item.installed && item.runnable) return { label: t('statusRunnable'), state: 'done' }
  if (item.installed && item.verification === 'failed')
    return { label: t('statusNeedsAttention'), state: 'warning' }
  if (item.installed) return { label: t('statusDetectedOnly'), state: 'warning' }
  return { label: t('statusNotInstalled'), state: 'idle' }
}

function discoveryLabel(item: HarnessInstallation, t: ExecutionSettingsT): string {
  if (item.detectedBy === 'configured-path') return t('discoveryConfigured')
  if (item.detectedBy === 'shell-path') return t('discoveryPath')
  if (item.detectedBy === 'known-path') return t('discoveryKnown')
  if (item.detectedBy === 'app-bundle') return t('discoveryAppBundle')
  return ''
}

function HarnessRow({
  item,
  busy,
  update,
  savePath,
  proxyDrafts,
  proxyErrors,
  proxyOutcome,
  editProxy,
  saveProxy,
  resetProxy,
  t,
}: {
  item: HarnessInstallation
  busy: boolean
  update: (id: string) => Promise<boolean>
  savePath: (id: string, command: string) => Promise<boolean>
  proxyDrafts: Parameters<typeof HarnessProxySection>[0]['drafts']
  proxyErrors: Parameters<typeof HarnessProxySection>[0]['errors']
  proxyOutcome: Parameters<typeof HarnessProxySection>[0]['outcome']
  editProxy: Parameters<typeof HarnessProxySection>[0]['onEdit']
  saveProxy: Parameters<typeof HarnessProxySection>[0]['onSave']
  resetProxy: Parameters<typeof HarnessProxySection>[0]['onReset']
  t: ExecutionSettingsT
}) {
  const status = statusOf(item, t)
  const discovery = discoveryLabel(item, t)
  return (
    <details className={rowCss.row} data-opl-harness-row={item.id}>
      <summary className={rowCss.summary}>
        <IconChevronRightOutlineRegular className={rowCss.chevron} size={14} />
        <span className={rowCss.identity}>
          <span className={rowCss.name}>{item.name}</span>
          <span className={rowCss.metadata}>
            <StateDot state={status.state} />
            <span className={rowCss.status}>{status.label}</span>
            {item.version && <span className={rowCss.metadataText}>{item.version}</span>}
            {discovery && <span className={rowCss.metadataText}>{discovery}</span>}
          </span>
        </span>
      </summary>
      <div className={rowCss.body}>
        {item.error && <p className={css.error}>{item.error}</p>}
        <p className={css.muted}>{item.instructions}</p>
        {item.installed && (
          <p className={css.muted}>
            {item.runnable
              ? t('runnableNote')
              : item.verification === 'failed'
                ? t('verificationFailedNote')
                : t('notRunnableNote')}
          </p>
        )}
        {item.path && (
          <p className={rowCss.path}>
            {t('launchEntry', { path: item.path })}
            {discovery ? t('discoverySuffix', { source: discovery }) : ''}
          </p>
        )}
        {item.installedCandidate && (
          <p className={css.muted}>
            {t('candidateEntry', { path: item.installedCandidate.path })}
            {item.installedCandidate.version
              ? t('candidateVersion', { version: item.installedCandidate.version })
              : ''}
            {t('candidateVerifyHint')}
          </p>
        )}
        {item.discovery && (
          <details>
            <summary>{t('otherDiscoverySummary')}</summary>
            {item.discovery.otherPaths.length > 0 && (
              <ul>
                {item.discovery.otherPaths.map((path) => (
                  <li className={rowCss.path} key={path}>
                    {path}
                  </li>
                ))}
              </ul>
            )}
            {item.discovery.limited && <p>{t('discoveryLimited')}</p>}
            <p>{t('discoveryManualHint')}</p>
          </details>
        )}
        <div className={rowCss.action}>
          {item.maintenanceAction && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy || item.maintenance?.state === 'running'}
              onClick={() => void update(item.id)}
            >
              {item.maintenance?.state === 'running'
                ? t('maintenanceRunning')
                : item.maintenanceAction === 'install'
                  ? t('maintenanceInstall')
                  : t('maintenanceUpdate')}
            </Button>
          )}
          {item.website && (
            <a href={item.website} target="_blank" rel="noreferrer">
              {t('officialWebsite')}
            </a>
          )}
        </div>
        {item.maintenance && (
          <div role="status">
            <p>
              {item.maintenance.state === 'running'
                ? t('maintenanceStatusRunning')
                : item.maintenance.state === 'completed'
                  ? t('maintenanceStatusCompleted')
                  : item.maintenance.message.startsWith('更新服务器的证书未受信任')
                    ? item.maintenance.message.split('\n')[0]
                    : t('maintenanceStatusFailed')}
            </p>
            <details>
              <summary>{t('updateDetailsSummary')}</summary>
              <pre className={rowCss.path}>{item.maintenance.message}</pre>
            </details>
          </div>
        )}
        {item.id !== 'dsh' && (
          <details className={css.pathDetails}>
            <summary>{t('executablePathSummary')}</summary>
            <div className={css.pathInputRow}>
              <input
                key={item.definition?.command ?? item.path ?? ''}
                className={css.input}
                defaultValue={item.definition?.command ?? item.path ?? ''}
                placeholder={t('executablePlaceholder')}
                disabled={busy}
                onBlur={(e) => {
                  const command = e.target.value.trim()
                  if (command !== (item.definition?.command ?? item.path ?? ''))
                    void savePath(item.id, command)
                }}
              />
              <ExecutableBrowser
                disabled={busy}
                label={t('browseExecutable')}
                onPick={(path) => void savePath(item.id, path)}
              />
            </div>
          </details>
        )}
        {item.definition && (
          <HarnessProxySection
            harness={item.definition}
            drafts={proxyDrafts}
            errors={proxyErrors}
            outcome={proxyOutcome}
            busy={busy}
            onEdit={editProxy}
            onSave={saveProxy}
            onReset={resetProxy}
            t={t}
          />
        )}
      </div>
    </details>
  )
}

export function HarnessSettings({
  call,
  embedded = false,
  t = defaultExecutionT,
}: {
  call: Call
  embedded?: boolean
  t?: ExecutionSettingsT
}) {
  const {
    draft,
    setDraft,
    items,
    error,
    busy,
    load,
    update,
    savePath,
    register,
    proxyDrafts,
    proxyErrors,
    proxyOutcome,
    editProxy,
    saveProxy,
    resetProxy,
  } = useHarnessSettings(call, t)
  const primary = items.filter((item) => isPrimaryHarness(item.id))
  const others = items.filter((item) => !isPrimaryHarness(item.id))
  const rowProps = {
    busy,
    update,
    savePath,
    proxyDrafts,
    proxyErrors,
    proxyOutcome,
    editProxy,
    saveProxy,
    resetProxy,
    t,
  }
  return (
    <div className={css.section} data-opl-panel="execution-settings" aria-busy={busy}>
      {embedded ? null : <h2 className={css.title}>{t('harnessTitle')}</h2>}
      <EngineUpdates
        call={call}
        t={t}
        detectButton={
          <Button variant="outline" disabled={busy} onClick={() => void load()}>
            {busy ? t('detecting') : t('redetect')}
          </Button>
        }
      />
      <p className={embedded ? css.muted : css.intro}>{t('harnessIntro')}</p>
      {error && <p role="alert">{error}</p>}
      {busy && !items.length && (
        <p className={css.muted} role="status">
          {t('detectingLocal')}
        </p>
      )}
      {items.length > 0 && (
        <div className={rowCss.directory}>
          {primary.map((item) => (
            <HarnessRow key={item.id} item={item} {...rowProps} />
          ))}
          {others.length > 0 && (
            <details data-opl-harness-group="more">
              <summary className={rowCss.groupSummary}>
                <IconChevronRightOutlineRegular className={rowCss.chevron} size={14} />
                {t('moreEngines')}
                <span className={rowCss.groupCount}>
                  {t('moreEnginesCount', { count: others.length })}
                </span>
              </summary>
              <div className={rowCss.groupBody}>
                {others.map((item) => (
                  <HarnessRow key={item.id} item={item} {...rowProps} />
                ))}
              </div>
            </details>
          )}
        </div>
      )}
      <details className={css.details} data-opl-panel="custom-acp-registration">
        <summary>{t('customAcpHeading')}</summary>
        <div className={css.detailsBody}>
          <label className={css.field}>
            {t('customAcpName')}
            <input
              className={css.input}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <label className={css.field}>
            {t('customAcpExecutable')}
            <div className={css.pathInputRow}>
              <input
                className={css.input}
                value={draft.command}
                placeholder={t('executablePlaceholder')}
                onChange={(e) => setDraft({ ...draft, command: e.target.value })}
              />
              <ExecutableBrowser
                disabled={busy}
                label={t('browseExecutable')}
                onPick={(path) => setDraft({ ...draft, command: path })}
              />
            </div>
          </label>
          <label className={css.field}>
            {t('customAcpArgs')}
            <input
              className={css.input}
              value={draft.args}
              placeholder={t('customAcpArgsPlaceholder')}
              onChange={(e) => setDraft({ ...draft, args: e.target.value })}
            />
          </label>
          <label className={css.field}>
            {t('customAcpFixedModel')}
            <input
              className={css.input}
              value={draft.fixedModel}
              placeholder={t('customAcpFixedModelPlaceholder')}
              onChange={(e) => setDraft({ ...draft, fixedModel: e.target.value })}
            />
          </label>
          <p className={css.muted}>{t('customAcpNote')}</p>
          <Button
            disabled={busy || !draft.name.trim() || !draft.command.trim()}
            onClick={() => void register()}
          >
            {t('customAcpSubmit')}
          </Button>
        </div>
      </details>
    </div>
  )
}
