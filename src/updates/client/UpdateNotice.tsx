/** A compact status pill aligned with the official sidebar update indicator. */
import { useSyncExternalStore, useEffect, useState } from 'react'
import { Button, IconDownloadOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { UpdateController } from './controller.ts'
import { useUpdateCountdown } from './countdown.ts'
import type { UpdateNavigation } from './navigation.ts'
import css from './Updates.module.css'

export type UpdateNoticeProps = PropsLocale<'settings.oplUpdates'> & {
  wide: boolean
  controller: UpdateController
  navigation?: UpdateNavigation
  openSettings?: (section?: 'engines') => void
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
  const [menu, setMenu] = useState(false)
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
  if (!hasRelease)
    return count && openSettings ? (
      <button
        type="button"
        className={css.notice}
        title={t('engineNotice', { count })}
        aria-label={t('engineNotice', { count })}
        onClick={() => openSettings('engines')}
      >
        <span className={css.icon} aria-hidden="true">
          <IconDownloadOutlineRegular size={14} />
        </span>
        <span>{t('noticeShort')}</span>
      </button>
    ) : null
  if (!status) return null
  const version = status.pendingVersion ?? status.release!.version
  const label = t(
    status.localCandidate
      ? status.pendingVersion
        ? 'candidatePending'
        : status.release?.compatibility === 'full-suite'
          ? 'noticeFullSuite'
          : 'noticeAvailable'
      : status.pendingVersion
        ? restart?.phase === 'handoff'
          ? 'noticeHandoff'
          : countdown !== null
            ? 'noticeCountdown'
            : restart?.phase === 'waiting'
              ? 'noticeWaiting'
              : 'noticePending'
        : status.release!.compatibility === 'full-suite'
          ? 'noticeFullSuite'
          : 'noticeAvailable',
    { version, seconds: countdown ?? 0 },
  )
  const releaseTitle =
    view.failure || status.error || !view.connected || !view.confirmed || view.uncertain
      ? `${label} ${t('noticeStale')}`
      : label
  const title = count ? releaseTitle + ' · ' + t('engineNotice', { count }) : releaseTitle
  const content = (
    <>
      <span className={css.icon} aria-hidden="true">
        <IconDownloadOutlineRegular size={14} />
      </span>
      <span>
        {countdown !== null ? t('noticeCountdownShort', { seconds: countdown }) : t('noticeShort')}
      </span>
    </>
  )
  const notice = openSettings ? (
    <button
      type="button"
      className={css.notice}
      title={title}
      aria-label={title}
      data-opl-update-notice={version}
      onClick={() => {
        if (count) {
          setMenu(true)
          return
        }
        navigation?.request()
        openSettings()
      }}
    >
      {content}
    </button>
  ) : status.release ? (
    <a
      className={css.notice}
      href={status.release.url}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      aria-label={title}
      data-opl-update-notice={version}
    >
      {content}
    </a>
  ) : (
    <span className={css.notice} title={title} aria-label={title} data-opl-update-notice={version}>
      {content}
    </span>
  )
  return (
    <div className={css.noticeGroup}>
      {count && openSettings ? (
        <Menu
          open={menu}
          side="top"
          portal
          autoFocus
          anchor={notice}
          items={[
            {
              id: 'suite',
              label: t('suiteMenu'),
            },
            { id: 'engines', label: t('engineMenu', { count }) },
          ]}
          onClose={() => setMenu(false)}
          onSelect={(id) => {
            setMenu(false)
            if (id === 'engines') openSettings('engines')
            else {
              navigation?.request()
              openSettings()
            }
          }}
        />
      ) : (
        notice
      )}
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
    </div>
  )
}
