import type {
  AutoReviewClientApi,
  AutoReviewConnectionSource,
} from '../../auto-review/contracts/settings.ts'
import {
  AutoReviewSection,
  type AutoReviewSectionProps,
} from '../../auto-review/client/AutoReviewSection.tsx'
import { ExecutionCatalogSection } from './ExecutionCatalogSection.tsx'
import { HarnessSettings } from './HarnessSettings.tsx'
import css from '../../shared/client/SettingsSection.module.css'
import type { ExecutionCall as Call } from '../../shared/client/remote-call.ts'

export interface AutoReviewSettingsSeat {
  api: AutoReviewClientApi
  connection?: AutoReviewConnectionSource
  t: AutoReviewSectionProps['t']
}

/**
 * One user-facing execution page. The common task is choosing a combination;
 * low-frequency program, proxy and approval controls stay in existing rows
 * inside this page instead of consuming separate settings navigation entries.
 */
export function ExecutionSettings({
  call,
  autoReview,
}: {
  call: Call
  autoReview?: AutoReviewSettingsSeat
}) {
  return (
    <div className={css.section} data-opl-panel="execution">
      <h2 className={css.title}>执行与组合</h2>
      <p className={css.intro}>
        为模型绑定 Harness
        与权限，并在同一页维护执行程序、独立网络代理和工具审批。已启用的组合显示在官方会话输入框中；模型与账号仍在对应来源页面管理。
      </p>
      <ExecutionCatalogSection call={call} embedded />
      <details className={css.details} data-opl-panel="execution-settings">
        <summary>执行引擎与网络代理</summary>
        <div className={css.detailsBody}>
          <HarnessSettings call={call} embedded />
        </div>
      </details>
      {autoReview ? (
        <details className={css.details} data-opl-panel="auto-review">
          <summary>工具审批（Auto Review）</summary>
          <div className={css.detailsBody}>
            <AutoReviewSection
              api={autoReview.api}
              {...(autoReview.connection ? { connection: autoReview.connection } : {})}
              embedded
              t={autoReview.t}
            />
          </div>
        </details>
      ) : (
        <p className={css.muted} data-opl-panel="auto-review">
          工具审批服务未就绪。
        </p>
      )}
    </div>
  )
}
