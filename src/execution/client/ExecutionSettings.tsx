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
}: {
  call: Call
  minimax: MiniMaxIntegrationSeat
  collaboration?: ReactNode
}) {
  const minimaxSnapshot = useMiniMaxIntegrationSnapshot(minimax.form)
  return (
    <div className={css.section} data-opl-panel="execution">
      <h2 className={css.title}>执行引擎与协作</h2>
      <p className={css.intro}>
        日常对话会自动按推荐策略匹配引擎，也可在聊天框「执行引擎」里为任意模型随时自由切换；本页用于管理本机执行引擎、网络代理、可选默认预设及跨引擎协作。
      </p>
      <HarnessSettings call={call} embedded />
      <details className={css.details}>
        <summary>自定义默认规则与快捷预设</summary>
        <div className={css.detailsBody}>
          <ExecutionCatalogSection
            call={call}
            embedded
            refreshKey={miniMaxIntegrationEnabled(minimaxSnapshot)}
          />
        </div>
      </details>
      <details className={css.details}>
        <summary>运行超时与队列限制</summary>
        <div className={css.detailsBody}>
          <ExecutionLimitsSection call={call} />
        </div>
      </details>
      {collaboration && (
        <details className={css.details}>
          <summary>跨引擎协作与外部 Codex 委派</summary>
          <div className={css.detailsBody}>{collaboration}</div>
        </details>
      )}
    </div>
  )
}
