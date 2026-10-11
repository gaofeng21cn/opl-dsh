/**
 * Available budget figures with sources and observation notes in hover text.
 */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { BudgetView } from './controller.ts'
import {
  METRIC_LABEL_KEY,
  METRIC_ORDER,
  SOURCE_LABEL_KEY,
  executionLabelKey,
  formatTokenCount,
  hasObservation,
  metricsByKey,
  warningRows,
} from './budget-view.ts'
import css from './ContextBudgetPanel.module.css'

/** Props of the read-only budget panel. */
export interface ContextBudgetPanelProps extends PropsLocale<'conversation.oplContextBudget'> {
  /** Latest accepted view of one Session. */
  view: BudgetView
  /** Run one more read: the only action offered, for both retry and refresh. */
  onRead: () => void
}

/**
 * Render one Session's budget observations.
 * @param props - view, read action, and locale seat.
 * @returns the panel body.
 */
export function ContextBudgetPanel({ view, onRead, t }: ContextBudgetPanelProps) {
  const snapshot = view.snapshot
  const failed = view.status === 'error'
  const empty = snapshot !== undefined && !hasObservation(snapshot)
  const status = failed
    ? t('statusError')
    : snapshot === undefined
      ? view.reloading
        ? t('statusReloading')
        : t('statusLoading')
      : empty
        ? t('statusEmpty')
        : undefined
  const metrics = snapshot ? metricsByKey(snapshot) : undefined
  const warnings = snapshot ? warningRows(snapshot) : []
  const notes = [
    t('panelHint'),
    t('unitNote'),
    ...warnings.map((warning) => t(warning.labelKey)),
    snapshot?.observedAt ? `${t('observedAt')}: ${snapshot.observedAt}` : '',
  ]
    .filter(Boolean)
    .join('\n')
  return (
    <div className={css.panel} role="dialog" aria-label={t('panelTitle')}>
      <div className={css.title} title={notes}>
        {t('panelTitle')}
      </div>
      <div className={failed ? css.error : css.status} role="status" aria-live="polite">
        {status}
      </div>
      {failed ? (
        <div className={css.failure}>
          <button
            type="button"
            className={css.retry}
            title={t('statusErrorHint')}
            onClick={() => onRead()}
          >
            {t('retry')}
          </button>
        </div>
      ) : null}
      {snapshot === undefined ? null : (
        <div className={css.actions}>
          <button type="button" className={css.retry} onClick={() => onRead()}>
            {t('refresh')}
          </button>
        </div>
      )}
      {snapshot === undefined ? null : (
        <>
          <dl className={css.rows}>
            {snapshot.execution === 'unknown' ? null : (
              <div className={css.row}>
                <dt className={css.term}>{t('route')}</dt>
                <dd className={css.value}>{t(executionLabelKey(snapshot.execution))}</dd>
              </div>
            )}
            {!snapshot.provider ? null : (
              <div className={css.row}>
                <dt className={css.term}>{t('provider')}</dt>
                <dd className={css.value}>{snapshot.provider}</dd>
              </div>
            )}
            {!snapshot.model ? null : (
              <div className={css.row}>
                <dt className={css.term}>{t('model')}</dt>
                <dd className={css.value}>{snapshot.model}</dd>
              </div>
            )}
          </dl>
          <dl className={css.rows} data-opl-budget-metrics="">
            {METRIC_ORDER.map((key) => {
              const metric = metrics?.get(key)
              const value = formatTokenCount(metric?.value)
              if (value === undefined || !metric) return null
              return (
                <div
                  className={css.row}
                  key={key}
                  title={`${t('sourceLabel')}: ${t(SOURCE_LABEL_KEY[metric.source])}\n${t(`help.${key}`)}`}
                >
                  <dt className={css.term}>{t(METRIC_LABEL_KEY[key])}</dt>
                  <dd className={css.value} data-opl-budget-metric={key}>
                    <span className={css.figure}>{value}</span>
                    <span className={css.unit}>{t('unitTokens')}</span>
                  </dd>
                </div>
              )
            })}
          </dl>
        </>
      )}
    </div>
  )
}
