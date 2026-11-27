import { useEffect, useId, useRef, useState } from 'react'
import { ExecutableBrowser } from '../../shared/client/ExecutableBrowser.tsx'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import css from '../../shared/client/SettingsSection.module.css'
import type { CoordinationStatus as Status } from '../../contracts/types.ts'
import { useCooperationSettings } from './use-cooperation-settings.ts'
import { RoleExecutions } from './RoleExecutions.tsx'
import { CoordinatorHooks, useCoordinatorHooks } from './CoordinatorHooks.tsx'
import { defaultCollaborationT, type CollaborationT } from './collaboration-locales.ts'
import type { RoleExecutionCall } from '../../shared/client/remote-call.ts'
import type { CoordinationCall, ExecutionCall } from '../../shared/client/remote-call.ts'
export function CoordinationSection({
  call,
  executionCall,
  roleCall,
  embedded = false,
  t = defaultCollaborationT,
}: {
  call: CoordinationCall
  executionCall?: ExecutionCall
  roleCall?: RoleExecutionCall
  embedded?: boolean
  t?: CollaborationT
}) {
  const {
    cooperation,
    error: cooperationError,
    busy: cooperationBusy,
    loading: cooperationLoading,
    save: saveCooperation,
    reload: reloadCooperation,
  } = useCooperationSettings(executionCall, t)
  const hooks = useCoordinatorHooks(call, t)
  const executableId = useId()
  const [status, setStatus] = useState<Status>(),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('')
  const [notificationConfigured, setNotificationConfigured] = useState<boolean>()
  const tRef = useRef(t)
  tRef.current = t
  const load = async () => {
    const saved = await call('coordination-status')
    setStatus(saved)
    setNotificationConfigured(
      saved.wakeTransport === 'codex-queue' && !!saved.wakeExecutable.trim(),
    )
  }
  useEffect(() => {
    void load().catch(() => setNotice(tRef.current('readStatusFailed')))
  }, [call])
  const act = async (operation: () => Promise<unknown>, message = tRef.current('actionSaved')) => {
    setBusy(true)
    setNotice('')
    try {
      await operation()
      await load()
      setNotice(message)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : tRef.current('actionFailed'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div
      className={css.section}
      data-opl-panel="collaboration"
      aria-busy={busy || cooperationBusy || cooperationLoading || (!status && !notice)}
    >
      {embedded ? null : <h2 className={css.title}>{t('title')}</h2>}
      <section className={css.collaborationGroup}>
        <h3 className={css.name}>{t('inAppHeading')}</h3>
        {!executionCall && <p className={css.muted}>{t('executionUnavailable')}</p>}
        {cooperationLoading && <p role="status">{t('loadingCooperation')}</p>}
        {cooperation && (
          <>
            <div className={css.row}>
              <span>{t('autoReviewTitle')}</span>
              <Switch
                label={t('autoReviewSwitch')}
                checked={cooperation.autoReview}
                disabled={cooperationBusy}
                onChange={(autoReview) => void saveCooperation({ ...cooperation, autoReview })}
              />
            </div>
            <label className={css.field}>
              {t('maxRevisionsLabel')}
              <select
                className={css.input}
                disabled={cooperationBusy}
                value={cooperation.maxRevisions}
                onChange={(e) =>
                  void saveCooperation({ ...cooperation, maxRevisions: Number(e.target.value) })
                }
              >
                {[0, 1, 2, 3, 4, 5].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </label>
          </>
        )}
        <details className={css.details}>
          <summary>{t('roleDefaultsSummary')}</summary>
          <RoleExecutions {...(roleCall ? { call: roleCall } : {})} t={t} />
        </details>
        {cooperationError && <p role="alert">{cooperationError}</p>}
      </section>
      <section className={css.collaborationGroup}>
        <div className={css.row}>
          <h3 className={css.name}>{t('delegationHeading')}</h3>
          <Button
            variant="outline"
            disabled={busy || cooperationBusy || !status}
            onClick={async () => {
              setBusy(true)
              setNotice('')
              try {
                const result = await call('delegation-setup')
                await load()
                await reloadCooperation()
                await hooks.run('status')
                setNotice(result)
              } catch (error) {
                setNotice(error instanceof Error ? error.message : t('setupFailed'))
              } finally {
                setBusy(false)
              }
            }}
          >
            {t('oneClickSetup')}
          </Button>
        </div>
        <p className={css.muted}>{t('delegationIntro')}</p>
        {notice && (
          <p className={css.notice} role="status">
            {notice}
          </p>
        )}
        <div className={css.detailsBody}>
          {cooperation && (
            <div className={css.row}>
              <span>{t('allowExternalCodexTitle')}</span>
              <Switch
                label={t('allowExternalCodexSwitch')}
                checked={cooperation.externalCodex}
                disabled={cooperationBusy}
                onChange={(externalCodex) =>
                  void saveCooperation({ ...cooperation, externalCodex })
                }
              />
            </div>
          )}
          <details className={css.details}>
            <summary>
              {t('skillSummary')}
              <span className={css.coordinationSummary}>
                {!status
                  ? t('statusUnknown')
                  : status.installed
                    ? t('statusInstalled')
                    : t('statusNotInstalled')}
              </span>
            </summary>
            <div className={css.detailsBody}>
              <Button
                variant="outline"
                disabled={busy || !status}
                onClick={() => {
                  void act(() => call('skill-install'))
                }}
              >
                {status?.installed ? t('updateRepairSkill') : t('installSkill')}
              </Button>
              <div className={css.row}>
                <span>{t('autoStartDshLabel')}</span>
                <Switch
                  label={t('autoStartDshLabel')}
                  checked={status?.autoStart ?? true}
                  disabled={busy || !status}
                  onChange={(value) => {
                    void act(() => call('auto-start', value))
                  }}
                />
              </div>
            </div>
          </details>
          <details className={css.details}>
            <summary>
              {t('notificationSummary')}
              <span className={css.coordinationSummary}>
                {notificationConfigured === undefined
                  ? t('statusUnknown')
                  : notificationConfigured
                    ? t('notifyConfigured')
                    : t('notifyUnconfigured')}
              </span>
            </summary>
            <div className={css.detailsBody}>
              <p className={css.muted}>{t('notifyIntro')}</p>
              {status && (
                <div className={css.form}>
                  <label className={css.field}>
                    <span>{t('callbackTransportLabel')}</span>
                    <select
                      className={css.input}
                      disabled={busy}
                      value={status.wakeTransport}
                      onChange={(e) =>
                        setStatus({
                          ...status,
                          wakeTransport:
                            e.target.value === 'codex-queue' ? 'codex-queue' : 'unconnected',
                        })
                      }
                    >
                      <option value="unconnected">{t('transportUnconnected')}</option>
                      <option value="codex-queue">{t('transportCodexQueue')}</option>
                    </select>
                  </label>
                  {status.wakeTransport === 'codex-queue' && (
                    <>
                      <label className={css.field}>
                        <span>{t('executionEnvLabel')}</span>
                        <select
                          className={css.input}
                          disabled={busy}
                          value={status.wakeExecution}
                          onChange={(e) =>
                            setStatus({
                              ...status,
                              wakeExecution: e.target.value === 'wsl' ? 'wsl' : 'native',
                            })
                          }
                        >
                          <option value="native">{t('envNative')}</option>
                          <option value="wsl">{t('envWsl')}</option>
                        </select>
                      </label>
                      <div className={css.field}>
                        <label htmlFor={executableId}>{t('bridgeExecutableLabel')}</label>
                        <div className={css.pathInputRow}>
                          <input
                            id={executableId}
                            disabled={busy}
                            className={css.input}
                            value={status.wakeExecutable}
                            onChange={(e) =>
                              setStatus({ ...status, wakeExecutable: e.target.value })
                            }
                          />
                          {status.wakeExecution !== 'wsl' && (
                            <ExecutableBrowser
                              disabled={busy}
                              label={t('browseExecutable')}
                              onPick={(path) => setStatus({ ...status, wakeExecutable: path })}
                            />
                          )}
                        </div>
                      </div>
                      {status.wakeExecution === 'wsl' && (
                        <label className={css.field}>
                          <span>{t('wslDistroLabel')}</span>
                          <input
                            disabled={busy}
                            className={css.input}
                            value={status.wakeDistro}
                            onChange={(e) => setStatus({ ...status, wakeDistro: e.target.value })}
                          />
                        </label>
                      )}
                    </>
                  )}
                  <Button
                    variant="outline"
                    disabled={busy || !status}
                    onClick={() => {
                      void act(() => call('wake-settings', status), t('notifySavedNotice'))
                    }}
                  >
                    {t('saveNotifyButton')}
                  </Button>
                </div>
              )}
            </div>
          </details>
          <details className={css.details}>
            <summary>
              {t('resumeSummary')}
              <span className={css.coordinationSummary}>{hooks.summary}</span>
            </summary>
            <CoordinatorHooks {...hooks} t={t} />
          </details>
        </div>
      </section>
    </div>
  )
}
