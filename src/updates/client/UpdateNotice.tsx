/** A compact status pill aligned with the official sidebar update indicator. */
import { useSyncExternalStore, useEffect, useRef, useState } from 'react'
import { Button, IconDownloadOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { OplUpdateRestart } from '../contracts.ts'
import type { UpdateController } from './controller.ts'
import { useUpdateCountdown } from './countdown.ts'
import type { UpdateNavigation } from './navigation.ts'
import css from './Updates.module.css'

export type UpdateNoticeProps = PropsLocale<'settings.oplUpdates'> & {
  wide: boolean
  controller: UpdateController
  navigation?: UpdateNavigation
  openSettings?: (section?: 'updates' | 'engines') => void
  engineCount?: () => Promise<number>
}

/** @param props - Sidebar geometry, shared status, and existing settings navigation. @returns Release notice. */
export function UpdateNotice({
  controller,
  navigation,
  openSettings,
  engineCount,
  wide,
  t,
}: UpdateNoticeProps) {
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const status = view.status
  const restart = status?.restart
  const countdown = useUpdateCountdown(
    status?.pendingVersion && restart?.phase === 'countdown' ? restart.dueAt : null,
    view.connected && view.confirmed && !view.uncertain && !view.failure,
  )
  const [count, setCount] = useState(0)
  const [blocked, setBlocked] = useState<OplUpdateRestart['reason'] | undefined>()
  const [applyError, setApplyError] = useState(false)
  const applyRequest = useRef(0)
  useEffect(
    () => () => {
      applyRequest.current += 1
    },
    [],
  )
  useEffect(() => {
    if (!engineCount) return
    let alive = true
    const read = () =>
      void engineCount()
        .then((n) => {
          if (alive) setCount(n)
        })
        .catch(() => {
          if (alive) setCount(0)
        })
    read()
    const timer = setInterval(read, 15000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [engineCount])
  const hasRelease = !!(status?.release || status?.pendingVersion)
  if (!wide) return null
  if (!hasRelease) {
    return count && openSettings ? (
      <button
        type="button"
        className={css.notice}
        title={t('engineNotice', { count })}
        aria-label={t('engineNotice', { count })}
        data-opl-engine-update-notice={count}
        onClick={() => {
          navigation?.request('engines')
          openSettings('updates')
        }}
      >
        <span className={css.icon} aria-hidden="true">
          <IconDownloadOutlineRegular size={14} />
        </span>
        <span>{t('engineNoticeShort', { count })}</span>
      </button>
    ) : null
  }
  if (!status) return null
  const version = status.pendingVersion ?? status.release!.version
  const pendingOutdated = Boolean(
    status.pendingVersion && status.release && status.pendingVersion !== status.release.version,
  )
  const canDirectApply = Boolean(
    !status.localCandidate && !pendingOutdated && status.release?.compatibility === 'enhancement',
  )
  const handoff = restart?.phase === 'handoff'
  const updating = view.operation === 'apply' || view.operation === 'prepare' || status.preparing
  const label = t(
    status.localCandidate
      ? status.pendingVersion
        ? 'candidatePending'
        : status.release?.compatibility === 'full-suite'
          ? 'noticeFullSuite'
          : 'noticeAvailable'
      : status.pendingVersion && !canDirectApply
        ? restart?.phase === 'handoff'
          ? 'noticeHandoff'
          : countdown !== null
            ? 'noticeCountdown'
            : restart?.phase === 'waiting'
              ? 'noticeWaiting'
              : 'noticePending'
        : handoff
          ? 'noticeHandoff'
          : countdown !== null
            ? 'noticeCountdown'
            : status.release?.compatibility === 'full-suite'
              ? 'noticeFullSuite'
              : 'noticeAvailable',
    { version, seconds: countdown ?? 0 },
  )
  const releaseTitle =
    view.failure || status.error || !view.connected || !view.confirmed || view.uncertain
      ? `${label} ${t('noticeStale')}`
      : label
  const shortText = handoff
    ? t('noticeRestartingShort')
    : updating
      ? t('noticeUpdatingShort')
      : countdown !== null
        ? t('noticeCountdownShort', { seconds: countdown })
        : t('noticeShort')
  const content = (
    <>
      <span className={css.icon} aria-hidden="true">
        <IconDownloadOutlineRegular size={14} />
      </span>
      <span>{shortText}</span>
    </>
  )
  const applyUpdate = async () => {
    if (updating || handoff) return
    setBlocked(undefined)
    setApplyError(false)
    const request = ++applyRequest.current
    const reason = await controller.applyNow()
    if (request !== applyRequest.current) return
    if (reason !== undefined) {
      setBlocked(reason)
      return
    }
    const latest = controller.getSnapshot()
    if (latest.status?.restart?.phase !== 'handoff' && (latest.failure || latest.status?.error)) {
      setApplyError(true)
    }
  }
  const openUpdates = () => {
    setBlocked(undefined)
    setApplyError(false)
    navigation?.request('suite')
    openSettings?.('updates')
  }
  const notice = canDirectApply ? (
    <button
      type="button"
      className={css.notice}
      title={releaseTitle}
      aria-label={releaseTitle}
      data-opl-update-notice={version}
      disabled={updating || handoff}
      onClick={() => void applyUpdate()}
    >
      {content}
    </button>
  ) : openSettings ? (
    <button
      type="button"
      className={css.notice}
      title={releaseTitle}
      aria-label={releaseTitle}
      data-opl-update-notice={version}
      onClick={openUpdates}
    >
      {content}
    </button>
  ) : status.release ? (
    <a
      className={css.notice}
      href={status.release.url}
      target="_blank"
      rel="noopener noreferrer"
      title={releaseTitle}
      aria-label={releaseTitle}
      data-opl-update-notice={version}
    >
      {content}
    </a>
  ) : (
    <span
      className={css.notice}
      title={releaseTitle}
      aria-label={releaseTitle}
      data-opl-update-notice={version}
    >
      {content}
    </span>
  )
  const failureKey = view.failure ?? status.error ?? 'apply-failed'
  return (
    <div className={css.noticeGroup}>
      {notice}
      {restart?.phase === 'countdown' && (
        <Button
          variant="ghost"
          size="sm"
          disabled={!controller.canPostpone()}
          onClick={() => void controller.postpone()}
        >
          {t(view.operation === 'postpone' ? 'postponing' : 'postpone')}
        </Button>
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
            {openSettings && (
              <Button variant="ghost" onClick={openUpdates}>
                {t('openUpdatesPage')}
              </Button>
            )}
            {controller.canCancel() && (
              <Button
                variant="ghost"
                onClick={() => {
                  setBlocked(undefined)
                  void controller.cancel()
                }}
              >
                {t('cancel')}
              </Button>
            )}
          </>
        }
      >
        <p>{t(blocked === 'busy' ? 'updateBusyBody' : (blocked ?? 'activity-unknown'))}</p>
      </Modal>
      <Modal
        open={applyError}
        title={t('updateApplyFailedTitle')}
        closeLabel={t('later')}
        onClose={() => setApplyError(false)}
        footer={
          <>
            <Button variant="outline" onClick={() => setApplyError(false)}>
              {t('later')}
            </Button>
            <Button variant="outline" onClick={() => void applyUpdate()}>
              {t('retryUpdate')}
            </Button>
            {openSettings && (
              <Button variant="ghost" onClick={openUpdates}>
                {t('openUpdatesPage')}
              </Button>
            )}
          </>
        }
      >
        <p role="alert">{t(failureKey)}</p>
      </Modal>
    </div>
  )
}
