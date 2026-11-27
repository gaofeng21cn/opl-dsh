/** Dedicated Updates settings page combining OPL DSH updates and external engine updates. */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Button, Modal, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { OplUpdateRestart } from '../contracts.ts'
import type { UpdateController } from './controller.ts'
import { PolicyControls } from './PolicyControls.tsx'
import { useUpdateCountdown } from './countdown.ts'
import type { UpdateNavigation } from './navigation.ts'
import css from '../../shared/client/SettingsSection.module.css'
import updatesCss from './Updates.module.css'

export type UpdatesSectionProps = PropsLocale<'settings.oplUpdates'> & {
  controller: UpdateController
  navigation?: UpdateNavigation
  renderEngineUpdates?: () => ReactNode
}

const noNavigation: UpdateNavigation = {
  request: () => {},
  getTarget: () => 'suite',
  subscribe: () => () => {},
  getSnapshot: () => 0,
  consume: () => 0,
  dispose: () => {},
}

/** @param props - Shared Host projection and typed locale. @returns Dedicated Updates page. */
export function UpdatesSection({
  controller,
  navigation: navigationProp,
  renderEngineUpdates,
  t,
}: UpdatesSectionProps) {
  const navigation = navigationProp ?? noNavigation
  const navigationRevision = useSyncExternalStore(
    navigation.subscribe,
    navigation.getSnapshot,
    navigation.getSnapshot,
  )
  const sectionRef = useRef<HTMLElement>(null)
  const enginesRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (navigationRevision === 0) return
    const target = navigation.getTarget() === 'engines' ? enginesRef.current : sectionRef.current
    if (!target) return
    const requests = navigation.consume()
    for (let index = 0; index < requests; index += 1)
      target.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [navigation, navigationRevision])
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const { status, operation } = view
  const [blocked, setBlocked] = useState<OplUpdateRestart['reason'] | undefined>()
  const applyRequest = useRef(0)
  useEffect(
    () => () => {
      applyRequest.current++
    },
    [],
  )
  const applyNow = async () => {
    const request = ++applyRequest.current
    const reason = await controller.applyNow()
    if (request !== applyRequest.current) return
    if (reason !== undefined) setBlocked(reason)
  }
  const checking = operation === 'check' || Boolean(status?.checking)
  const preparing =
    operation === 'prepare' ||
    (operation === 'apply' && !status?.pendingVersion) ||
    Boolean(status?.preparing)
  const handoff = status?.restart?.phase === 'handoff'
  const busy = operation !== null || checking || preparing || handoff
  const writable = view.connected && view.confirmed && !busy && !view.uncertain && status !== null
  const failure = view.failure ?? status?.error
  const failureDetails = status?.failure ?? null
  const release = status?.release
  const restart = status?.restart
  const pendingMatchesRelease = Boolean(
    status?.pendingVersion && release && status.pendingVersion === release.version,
  )
  const pendingOutdated = Boolean(
    status?.pendingVersion && release && status.pendingVersion !== release.version,
  )
  const showRefreshStatus = Boolean(
    view.failure || status?.error === 'prepare-lock-failed' || restart?.phase === 'failed',
  )
  const countdown = useUpdateCountdown(
    status?.pendingVersion && restart?.phase === 'countdown' ? restart.dueAt : null,
    view.connected && view.confirmed && !view.uncertain && !view.failure,
  )
  const latestCheckFoundNothing =
    status !== null &&
    status.lastSuccessAt !== null &&
    !release &&
    !status.localCandidate &&
    !status.pendingVersion &&
    !failure &&
    !busy &&
    view.connected

  return (
    <div className={css.section}>
      <div className={css.pageHeader}>
        <h2 className={css.title}>{t('title')}</h2>
      </div>
      <section
        ref={sectionRef}
        className={css.card}
        data-opl-panel="updates"
        aria-label={t('title')}
      >
        <div className={css.cardHeader}>
          <div className={css.cardHeaderText}>
            <h3 className={css.cardTitle}>{t('appUpdatesHeading')}</h3>
            {status?.checkedAt ? (
              <p className={css.muted}>
                {t('lastChecked')}:{' '}
                <time dateTime={status.checkedAt}>
                  {new Date(status.checkedAt).toLocaleString()}
                </time>
              </p>
            ) : status ? (
              <p className={css.muted}>{t('neverChecked')}</p>
            ) : null}
          </div>
          <div className={updatesCss.actions}>
            <Button
              variant="outline"
              disabled={!view.connected || Boolean(busy)}
              onClick={() => void controller.check()}
            >
              {t(checking ? 'checking' : 'check')}
            </Button>
            {showRefreshStatus && (
              <Button
                variant="outline"
                disabled={!view.connected || operation !== null}
                onClick={() => controller.refresh()}
              >
                {t('refreshStatus')}
              </Button>
            )}
          </div>
        </div>
        {status && (
          <dl className={`${css.facts} ${updatesCss.versions}`}>
            <div>
              <dt className={css.factLabel}>{t('installedVersion')}</dt>
              <dd className={`${css.factValue} ${updatesCss.versionValue}`}>
                {status.installedVersion}
              </dd>
            </div>
            <div>
              <dt className={css.factLabel}>{t('officialVersion')}</dt>
              <dd className={`${css.factValue} ${updatesCss.versionValue}`}>
                {status.officialVersion}
              </dd>
            </div>
          </dl>
        )}
        {status?.localCandidate && <p className={css.notice}>{t('localCandidate')}</p>}
        <div className={css.cardRows}>
          <div className={css.preferenceRow}>
            <div className={css.preferenceText}>
              <span className={css.preferenceTitle}>{t('automatic')}</span>
              <span className={css.preferenceDescription}>{t('automaticHelp')}</span>
            </div>
            <Switch
              label={t('automatic')}
              checked={status?.automatic ?? false}
              disabled={!writable}
              onChange={(enabled) => void controller.setAutomatic(enabled)}
            />
          </div>
          <PolicyControls controller={controller} status={status} writable={writable} t={t} />
        </div>
        {!view.connected && (
          <p role="status" className={css.muted}>
            {t('disconnected')}
          </p>
        )}
        {operation === 'status' && (
          <p role="status" className={css.muted}>
            {t('loading')}
          </p>
        )}
        {operation === 'automatic' && (
          <p role="status" className={css.muted}>
            {t('saving')}
          </p>
        )}
        {operation === 'policy' && (
          <p role="status" className={css.muted}>
            {t('savingPolicy')}
          </p>
        )}
        {operation === 'postpone' && (
          <p role="status" className={css.muted}>
            {t('postponing')}
          </p>
        )}
        {operation === 'cancel' && (
          <p role="status" className={css.muted}>
            {t('cancelling')}
          </p>
        )}
        {operation === 'apply' && !preparing && (
          <p role="status" className={css.muted}>
            {t('applying')}
          </p>
        )}
        {status?.lastSuccessAt && status.lastSuccessAt !== status.checkedAt && (
          <p className={css.muted}>
            {t('lastSuccess')}:{' '}
            <time dateTime={status.lastSuccessAt}>
              {new Date(status.lastSuccessAt).toLocaleString()}
            </time>
          </p>
        )}
        {failure && (
          <>
            <p role="alert" className={css.errorBanner}>
              {t(failure)}
            </p>
            {failureDetails && (
              <p className={css.muted} data-opl-update-failure-details>
                {t('failureDetail', {
                  stage: failureDetails.stage,
                  reason: failureDetails.reason,
                  detail: [
                    failureDetails.httpStatus === undefined
                      ? ''
                      : ` HTTP ${failureDetails.httpStatus}`,
                    failureDetails.systemCode === undefined
                      ? ''
                      : ` (${failureDetails.systemCode})`,
                  ].join(''),
                })}
              </p>
            )}
          </>
        )}
        {latestCheckFoundNothing && (
          <p role="status" className={css.muted}>
            {t('noUpdate')}
          </p>
        )}
        {release && (
          <div className={css.card} data-opl-update-release={release.version}>
            <h3 className={css.name}>{t('release', { version: release.version })}</h3>
            {release.summary && <p className={updatesCss.summary}>{release.summary}</p>}
            <p className={css.muted}>
              {t('releaseOfficialVersion')}: {release.officialVersion}
            </p>
            <p className={css.muted}>
              {t('publishedAt')}:{' '}
              <time dateTime={release.publishedAt}>
                {new Date(release.publishedAt).toLocaleString()}
              </time>
            </p>
            <p className={css.muted}>
              {t(release.compatibility === 'enhancement' ? 'enhancement' : 'fullSuite')}
            </p>
            <a
              className={updatesCss.link}
              href={release.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('releaseNotes')}
            </a>
            {(status?.localCandidate || release.compatibility === 'full-suite') && (
              <a
                className={updatesCss.link}
                href={release.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t('download')}
              </a>
            )}
            {release.compatibility === 'enhancement' && (
              <>
                {!pendingMatchesRelease && (
                  <Button
                    variant="outline"
                    disabled={!writable}
                    onClick={() => void controller.prepare()}
                  >
                    {t(preparing ? 'preparing' : 'prepare')}
                  </Button>
                )}
                {!status?.localCandidate && !pendingOutdated && (
                  <Button variant="outline" disabled={!writable} onClick={() => void applyNow()}>
                    {t(operation === 'apply' ? 'applying' : 'applyNow')}
                  </Button>
                )}
              </>
            )}
          </div>
        )}
        {preparing && (
          <div className={`${css.notice} ${updatesCss.progress}`}>
            <p role="status">{t('preparing')}</p>
            <Button
              variant="ghost"
              disabled={!controller.canCancel()}
              onClick={() => void controller.cancel()}
            >
              {t('cancelDownload')}
            </Button>
          </div>
        )}
        {status?.pendingVersion && !preparing && (
          <div
            className={`${css.notice} ${updatesCss.progress}`}
            data-opl-update-pending={status.pendingVersion}
          >
            <p role={countdown !== null ? 'timer' : 'status'}>
              {t(
                handoff
                  ? 'restartHandoff'
                  : pendingOutdated
                    ? 'pendingOutdated'
                    : status.localCandidate
                      ? 'candidatePending'
                      : countdown !== null
                        ? 'restartCountdown'
                        : restart?.phase === 'waiting'
                          ? 'restartWaiting'
                          : restart?.phase === 'blocked'
                            ? 'restartBlocked'
                            : !release
                              ? 'pendingUnchecked'
                              : 'pending',
                {
                  version: status.pendingVersion,
                  latest: release?.version ?? '',
                  seconds: countdown ?? 0,
                },
              )}
            </p>
            {restart?.phase === 'waiting' && restart.reason && (
              <p className={css.muted}>{t(restart.reason)}</p>
            )}
            {restart?.phase === 'failed' && (
              <p className={css.muted}>{t(restart.reason ?? 'update-failed')}</p>
            )}
            {!handoff && (
              <div className={updatesCss.actions}>
                {restart?.phase === 'countdown' && (
                  <Button
                    variant="ghost"
                    disabled={!controller.canPostpone()}
                    onClick={() => void controller.postpone()}
                  >
                    {t(operation === 'postpone' ? 'postponing' : 'postpone')}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  disabled={!controller.canCancel()}
                  onClick={() => void controller.cancel()}
                >
                  {t(operation === 'cancel' ? 'cancelling' : 'cancel')}
                </Button>
              </div>
            )}
          </div>
        )}
        <Modal
          open={blocked !== undefined}
          title={t('updateBlockedTitle')}
          closeLabel={t('later')}
          onClose={() => setBlocked(undefined)}
          footer={
            <>
              <Button variant="outline" onClick={() => setBlocked(undefined)}>
                {t('later')}
              </Button>
              <Button
                variant="ghost"
                disabled={!controller.canCancel()}
                onClick={() => {
                  setBlocked(undefined)
                  void controller.cancel()
                }}
              >
                {t('cancel')}
              </Button>
            </>
          }
        >
          <p>{t(blocked === 'busy' ? 'updateBusyBody' : (blocked ?? 'activity-unknown'))}</p>
        </Modal>
      </section>
      {renderEngineUpdates && (
        <section
          ref={enginesRef}
          className={css.card}
          data-opl-panel="engine-updates"
          aria-label={t('engineUpdatesHeading')}
        >
          <div className={css.cardHeader}>
            <h3 className={css.cardTitle}>{t('engineUpdatesHeading')}</h3>
          </div>
          {renderEngineUpdates()}
        </section>
      )}
    </div>
  )
}
