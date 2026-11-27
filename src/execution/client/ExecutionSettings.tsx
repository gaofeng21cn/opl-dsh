import type { ReactNode } from 'react'
import { ExecutionCatalogSection } from './ExecutionCatalogSection.tsx'
import { HarnessSettings } from './HarnessSettings.tsx'
import { ExecutionLimitsSection } from './ExecutionLimitsSection.tsx'
import {
  miniMaxIntegrationEnabled,
  useMiniMaxIntegrationSnapshot,
  type MiniMaxIntegrationSeat,
} from './MiniMaxIntegration.tsx'
import css from '../../shared/client/SettingsSection.module.css'
import type { ExecutionCall as Call } from '../../shared/client/remote-call.ts'
import { defaultExecutionT, type ExecutionSettingsT } from './execution-settings-locales.ts'

/**
 * One user-facing execution & collaboration page. Common tasks (detecting local engines,
 * one-click install/update, per-harness proxies, and custom standard ACP engines) sit flat at the
 * top, while default overrides, turn limits, and cross-harness collaboration sit inside
 * collapsible panels below.
 */
export function ExecutionSettings({
  call,
  minimax,
  collaboration,
  t = defaultExecutionT,
}: {
  call: Call
  minimax: MiniMaxIntegrationSeat
  collaboration?: ReactNode
  t?: ExecutionSettingsT
}) {
  const minimaxSnapshot = useMiniMaxIntegrationSnapshot(minimax.form)
  return (
    <div className={css.section} data-opl-panel="execution">
      <h2 className={css.title}>{t('pageTitle')}</h2>
      <p className={css.intro}>{t('pageIntro')}</p>
      <HarnessSettings call={call} embedded t={t} />
      <details className={css.details}>
        <summary>{t('sectionCustomDefaults')}</summary>
        <div className={css.detailsBody}>
          <ExecutionCatalogSection
            call={call}
            embedded
            refreshKey={miniMaxIntegrationEnabled(minimaxSnapshot)}
            t={t}
          />
        </div>
      </details>
      <details className={css.details}>
        <summary>{t('sectionLimits')}</summary>
        <div className={css.detailsBody}>
          <ExecutionLimitsSection call={call} t={t} />
        </div>
      </details>
      {collaboration && (
        <details className={css.details}>
          <summary>{t('sectionCollaboration')}</summary>
          <div className={css.detailsBody}>{collaboration}</div>
        </details>
      )}
    </div>
  )
}
