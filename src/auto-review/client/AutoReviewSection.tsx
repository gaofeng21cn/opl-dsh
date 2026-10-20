/**
 * Auto Review settings section — the user-facing surface mounted into the
 * official `settings.section` list slot.
 *
 * The section owns no transport and no Session service: it reads and saves only
 * through {@link AutoReviewSectionProps.api}, and enabling it never touches a
 * Session permission preset. Copy is fully locale-owned; the only actions are
 * the explicit Save and the explicit re-read, so a switch change alone writes
 * nothing.
 *
 * A Host connection generation is observed through the optional
 * {@link AutoReviewSectionProps.connection}: a lost or not-yet-ready generation
 * disables edits and writes and invalidates in-flight work, and a new generation
 * only ever triggers a read (never a write). A replaced `api` is treated as the
 * same kind of Host replacement.
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  AutoReviewClientApi,
  AutoReviewConnectionSource,
  AutoReviewFailure,
  AutoReviewPreferences,
  AutoReviewRouteOption,
  AutoReviewStatus,
} from '../contracts/settings.ts'
import { REVIEW_BUDGET_RANGE } from './config.ts'
import { AutoReviewSettingsStore, effectivePreferences, type AutoReviewView } from './controller.ts'
import type { AutoReviewLocaleKey } from './locales.ts'
import {
  budgetIsSubmittable,
  findRoute,
  routeKey,
  withBudget,
  withCurrentRoute,
  withFixedEffort,
  withFixedRoute,
} from './preferences.ts'
import css from '../../shared/client/SettingsSection.module.css'

/** Props composed by the slot framework plus the injected service seams. */
export interface AutoReviewSectionProps extends PropsLocale<'settings.oplAutoReview'> {
  /** The Host-backed read/save seam from {@link Config}. */
  api: AutoReviewClientApi
  /**
   * Optional Host connection generation source. Absent means the api is a
   * single, always-current generation (the original standalone contract).
   */
  connection?: AutoReviewConnectionSource
  /** Render beneath the execution page's section heading instead of owning a page. */
  embedded?: boolean
}

/** One dictionary key per Host state. */
const STATE_KEY: Record<AutoReviewStatus['state'], AutoReviewLocaleKey> = {
  disabled: 'state.disabled',
  ready: 'state.ready',
  unavailable: 'state.unavailable',
  draining: 'state.draining',
}

/** One dictionary key per DTO failure label; no raw Host text can reach the screen. */
const FAILURE_KEY: Record<AutoReviewFailure, AutoReviewLocaleKey> = {
  unavailable: 'failure.unavailable',
  'invalid-settings': 'failure.invalid-settings',
  'stale-settings': 'failure.stale-settings',
  'sessions-active': 'failure.sessions-active',
  'auto-sessions-remain': 'failure.auto-sessions-remain',
  'save-failed': 'failure.save-failed',
}

/** Stable no-op observables for an unwired connection source. */
const NO_SUBSCRIPTION =
  (_listener: () => void): (() => void) =>
  () => {}
const NO_GENERATION = (): undefined => undefined

/**
 * Whether a successful settings read of the current generation is on screen.
 *
 * An `unavailable` reviewer is deliberately NOT excluded: the settings read
 * succeeded, so the user may still repair the route or request disabling, and
 * the Host remains the authority that accepts or refuses it.
 * @param view - current store value.
 * @returns whether the settings read succeeded.
 */
export function serviceReady(view: AutoReviewView): boolean {
  return view.readState === 'ready' && view.status !== undefined
}

/**
 * Why editing is disabled right now, or undefined when it is allowed.
 *
 * Precedence: a save in flight, then a read in flight, then a missing Host
 * generation, then a failed read, then an unconfirmed save. A stale or
 * `unavailable` state never disables editing here — the first blocks saving
 * until a re-read, the second is the very thing the user may need to repair.
 * @param view - current store value.
 * @returns the dictionary key of the reason, if any.
 */
export function disabledReasonKey(view: AutoReviewView): AutoReviewLocaleKey | undefined {
  if (view.saving) return 'disabledReasonBusy'
  if (view.reading) return 'disabledReasonRefreshing'
  if (!view.connected) return 'disabledReasonDisconnected'
  if (view.readState === 'error') return 'disabledReasonReadFailed'
  if (view.status === undefined) return 'disabledReasonLoading'
  if (view.uncertain) return 'disabledReasonUncertain'
  if (view.status.state === 'draining') return 'disabledReasonDraining'
  return undefined
}

/**
 * Why the Save action is unavailable, or undefined when it may be pressed.
 *
 * Editing can be allowed while a re-read is still required; this narrows that
 * case for the save control's own explanation.
 * @param view - current store value.
 * @returns the dictionary key of the reason, if any.
 */
export function saveBlockedReasonKey(view: AutoReviewView): AutoReviewLocaleKey | undefined {
  const disabled = disabledReasonKey(view)
  if (disabled !== undefined) return disabled
  if (view.stale) return 'disabledReasonStale'
  return undefined
}

/** Advertised providers, in Host order, without duplicates. */
function providersOf(routes: readonly AutoReviewRouteOption[]): AutoReviewRouteOption[] {
  const seen = new Set<string>()
  const providers: AutoReviewRouteOption[] = []
  for (const route of routes) {
    if (seen.has(route.provider)) continue
    seen.add(route.provider)
    providers.push(route)
  }
  return providers
}

/**
 * Render the Auto Review settings section.
 * @param props - injected service seams and locale seat.
 * @returns the settings section body.
 */
export function AutoReviewSection({
  api,
  connection,
  embedded = false,
  t,
}: AutoReviewSectionProps) {
  // The store outlives api and connection swaps; `mount` rebinds both below, so
  // a replaced seam invalidates in-flight work instead of merely being read later.
  const store = useMemo(() => new AutoReviewSettingsStore({ api }), [])
  const hasSource = connection !== undefined
  const source = useMemo(() => {
    if (!connection) return { subscribe: NO_SUBSCRIPTION, getSnapshot: NO_GENERATION }
    return {
      subscribe: (listener: () => void) => connection.subscribe(listener),
      getSnapshot: () => connection.getSnapshot(),
    }
  }, [connection])
  const generation = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  // One effect binds both seams: a changed api or a changed generation remounts
  // the store, which invalidates in-flight work, and only then re-reads. The
  // cleanup invalidates again on unmount without making the store unusable, so a
  // StrictMode mount/unmount/mount cycle settles into one live binding.
  useEffect(() => {
    store.mount(api, hasSource, generation)
    if (store.isConnected()) void store.load()
    return () => store.unmount()
  }, [store, api, hasSource, generation])

  const preferences = effectivePreferences(view)
  const reason = disabledReasonKey(view)
  const editable = reason === undefined
  const routes = view.status?.routes ?? []
  const failure = view.failure
  const submittable = preferences !== undefined && budgetIsSubmittable(preferences)
  const saveDisabled = !editable || view.stale || !view.dirty || !submittable
  const saveTitleKey = saveBlockedReasonKey(view)
  const routeMode = preferences?.reviewer.mode === 'decision' ? 'decision' : 'fixed'
  const fixed = preferences?.reviewer.mode === 'fixed' || preferences?.reviewer.mode === 'decision'
  const selectedRoute =
    fixed && (preferences.reviewer.mode === 'fixed' || preferences.reviewer.mode === 'decision')
      ? preferences.reviewer.route
      : undefined
  const provider = selectedRoute?.provider ?? ''
  const model = selectedRoute?.model ?? ''
  const reviewerRoutes = routes.filter((route) => route.kind !== 'decision')
  const decisionRoutes = routes.filter((route) => route.kind === 'decision')
  const selectableRoutes = routeMode === 'decision' ? decisionRoutes : reviewerRoutes
  const models = selectableRoutes.filter((route) => route.provider === provider)
  const fixedOption = fixed ? findRoute(selectableRoutes, provider, model) : undefined
  const routeMissing = fixed && fixedOption === undefined
  const decisionRouteValue = selectedRoute === undefined ? '' : routeKey(provider, model)

  const edit = (next: AutoReviewPreferences): void => store.edit(next)
  const changeProvider = (next: string): void => {
    if (!preferences) return
    const option = selectableRoutes.find((route) => route.provider === next)
    if (option) edit(withFixedRoute(preferences, option, routeMode))
  }
  const changeModel = (next: string): void => {
    if (!preferences) return
    const option = findRoute(selectableRoutes, provider, next)
    if (option) edit(withFixedRoute(preferences, option, routeMode))
  }
  const changeDecisionModel = (next: string): void => {
    if (!preferences) return
    const option = decisionRoutes.find((route) => routeKey(route.provider, route.model) === next)
    if (option) edit(withFixedRoute(preferences, option, 'decision'))
  }

  return (
    <div
      className={css.section}
      data-opl-panel="auto-review"
      aria-busy={view.reading || view.saving}
    >
      {embedded ? null : <h2 className={css.title}>{t('title')}</h2>}
      <p className={css.intro}>{t('intro')}</p>
      <p className={css.muted}>{t('distinction')}</p>

      {view.readState === 'loading' && view.status === undefined ? (
        <p role="status">{t('statusLoading')}</p>
      ) : null}

      {view.connected ? null : (
        <p className={css.error} role="status" data-opl-auto-review-disconnected="">
          {t('connectionLost')}
        </p>
      )}

      {view.readState === 'error' ? (
        <div role="alert" data-opl-auto-review-read-error="">
          <p className={css.error}>{t('readFailed')}</p>
          <p className={css.muted}>{t('readFailedHint')}</p>
          <Button
            variant="outline"
            size="sm"
            data-opl-auto-review-retry=""
            disabled={view.reading || !view.connected}
            onClick={() => void store.load()}
          >
            {t('retry')}
          </Button>
        </div>
      ) : null}

      {view.status === undefined ? null : (
        <>
          <div className={css.card}>
            <h3 className={css.name}>{t('statusTitle')}</h3>
            <dl className={css.facts}>
              <div>
                <span className={css.factLabel}>{t('stateLabel')}</span>
                <span className={css.factValue} data-opl-auto-review-state={view.status.state}>
                  {t(STATE_KEY[view.status.state])}
                </span>
              </div>
              <div>
                <span className={css.factLabel}>{t('effectiveLabel')}</span>
                <span
                  className={css.factValue}
                  data-opl-auto-review-effective-enabled={
                    view.status.preferences.enabled ? 'true' : 'false'
                  }
                >
                  {t(view.status.preferences.enabled ? 'effectiveOn' : 'effectiveOff')}
                </span>
              </div>
              <div>
                <span className={css.factLabel}>{t('activeReviews')}</span>
                <span className={css.factValue}>{view.status.activeReviews}</span>
              </div>
              <div>
                <span className={css.factLabel}>{t('autoSessions')}</span>
                <span className={css.factValue}>{view.status.autoSessions}</span>
              </div>
              <div>
                <span className={css.factLabel}>{t('revision')}</span>
                <span
                  className={css.factValue}
                  data-opl-auto-review-revision={view.status.revision}
                >
                  {view.status.revision}
                </span>
              </div>
            </dl>
            {view.status.state === 'unavailable' ? (
              <p className={css.error} role="alert">
                {t('routeUnavailable')}
              </p>
            ) : null}
            {reason === undefined ? null : (
              <p className={css.muted} data-opl-auto-review-disabled-reason={reason}>
                {t(reason)}
              </p>
            )}
            {serviceReady(view) ? null : (
              <p className={css.muted} role="status">
                {t('serviceNotReady')}
              </p>
            )}
          </div>

          {failure === undefined ? null : (
            <p className={css.error} role="alert" data-opl-auto-review-failure={failure}>
              {t('failureTitle')}：{t(FAILURE_KEY[failure])}
            </p>
          )}
          {view.uncertain ? (
            <p className={css.error} role="alert" data-opl-auto-review-uncertain="">
              {t('uncertainNotice')}
            </p>
          ) : null}
          {view.stale ? (
            <p className={css.error} role="alert" data-opl-auto-review-stale="">
              {t('stale')}
            </p>
          ) : null}
          {view.conflict ? (
            <p className={css.notice} role="status" data-opl-auto-review-conflict="">
              {t('conflict')}
            </p>
          ) : null}
          {view.saved ? (
            <p className={css.notice} role="status" data-opl-auto-review-saved="">
              {t('saved')}
            </p>
          ) : null}

          {preferences === undefined ? null : (
            <>
              <div className={css.card}>
                <h3 className={css.name}>{t('enableTitle')}</h3>
                <p className={css.muted}>{t('boundarySandbox')}</p>
                <div className={css.row}>
                  <span>{t('enableLabel')}</span>
                  <Switch
                    checked={preferences.enabled}
                    disabled={!editable}
                    label={t('enableAria')}
                    onChange={(enabled) => edit({ ...preferences, enabled })}
                  />
                </div>
                {view.dirty ? (
                  <p className={css.muted} data-opl-auto-review-draft-pending="">
                    {t('draftPending')}
                  </p>
                ) : null}
                <p className={css.muted}>{t('presetNotice')}</p>
                <p className={css.muted}>{t('boundaryNative')}</p>
              </div>

              <div className={css.card}>
                <h3 className={css.name}>{t('routeTitle')}</h3>
                <p className={css.muted}>{t('routeSourceNote')}</p>
                <label className={css.row}>
                  <span>{t('routeCurrent')}</span>
                  <input
                    type="radio"
                    name="opl-auto-review-route"
                    value="current"
                    checked={preferences.reviewer.mode === 'current'}
                    disabled={!editable}
                    onChange={() => edit(withCurrentRoute(preferences))}
                  />
                </label>
                <label className={css.row}>
                  <span>{t('routeFixed')}</span>
                  <input
                    type="radio"
                    name="opl-auto-review-route"
                    value="fixed"
                    checked={preferences.reviewer.mode === 'fixed'}
                    disabled={!editable || reviewerRoutes.length === 0}
                    onChange={() => {
                      const first = reviewerRoutes[0]
                      if (first) edit(withFixedRoute(preferences, first, 'fixed'))
                    }}
                  />
                </label>
                <label className={css.row}>
                  <span>{t('routeDecision')}</span>
                  <input
                    type="radio"
                    name="opl-auto-review-route"
                    value="decision"
                    checked={preferences.reviewer.mode === 'decision'}
                    disabled={!editable || decisionRoutes.length === 0}
                    onChange={() => {
                      const first = decisionRoutes[0]
                      if (first) edit(withFixedRoute(preferences, first, 'decision'))
                    }}
                  />
                </label>
                {routes.length === 0 ? (
                  <p className={css.muted} data-opl-auto-review-routes-empty="">
                    {t('routesEmpty')}
                  </p>
                ) : null}
                {routeMissing ? (
                  <p className={css.muted} data-opl-auto-review-route-missing="">
                    {t('routeMissing')}
                  </p>
                ) : null}
                {fixed ? (
                  preferences.reviewer.mode === 'decision' ? (
                    <label className={css.field}>
                      <span>{t('decisionModel')}</span>
                      <select
                        className={css.input}
                        data-opl-auto-review-select="decision-model"
                        disabled={!editable || decisionRoutes.length === 0}
                        value={decisionRouteValue}
                        onChange={(event) => changeDecisionModel(event.target.value)}
                      >
                        {decisionRoutes.map((route) => (
                          <option
                            key={routeKey(route.provider, route.model)}
                            value={routeKey(route.provider, route.model)}
                          >
                            {route.providerName} · {route.modelName}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <div className={css.form}>
                      <label className={css.field}>
                        <span>{t('provider')}</span>
                        <select
                          className={css.input}
                          data-opl-auto-review-select="provider"
                          disabled={!editable || selectableRoutes.length === 0}
                          value={provider}
                          onChange={(event) => changeProvider(event.target.value)}
                        >
                          {providersOf(selectableRoutes).map((route) => (
                            <option key={route.provider} value={route.provider}>
                              {route.providerName}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className={css.field}>
                        <span>{t('model')}</span>
                        <select
                          className={css.input}
                          data-opl-auto-review-select="model"
                          disabled={!editable || models.length === 0}
                          value={model}
                          onChange={(event) => changeModel(event.target.value)}
                        >
                          {models.map((route) => (
                            <option key={route.model} value={route.model}>
                              {route.modelName}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className={css.field}>
                        <span>{t('effort')}</span>
                        {fixedOption === undefined || fixedOption.efforts.length === 0 ? (
                          <span className={css.muted}>{t('effortNone')}</span>
                        ) : (
                          <select
                            className={css.input}
                            data-opl-auto-review-select="effort"
                            disabled={!editable}
                            value={
                              preferences.reviewer.mode === 'fixed' &&
                              preferences.reviewer.route.reasoningEffort !== undefined
                                ? preferences.reviewer.route.reasoningEffort
                                : ''
                            }
                            onChange={(event) =>
                              edit(withFixedEffort(preferences, routes, event.target.value))
                            }
                          >
                            {fixedOption.efforts.map((effort) => (
                              <option key={effort} value={effort}>
                                {effort}
                              </option>
                            ))}
                          </select>
                        )}
                      </label>
                    </div>
                  )
                ) : null}
                <p className={css.muted}>{t('noRanking')}</p>
              </div>

              <div className={css.card}>
                <h3 className={css.name}>{t('limitsTitle')}</h3>
                <div className={css.form}>
                  <label className={css.field}>
                    <span>{t('timeoutMs')}</span>
                    <input
                      className={css.input}
                      type="number"
                      data-opl-auto-review-budget="timeoutMs"
                      min={REVIEW_BUDGET_RANGE.timeoutMs.min}
                      max={REVIEW_BUDGET_RANGE.timeoutMs.max}
                      disabled={!editable}
                      value={String(preferences.timeoutMs)}
                      onChange={(event) =>
                        edit(withBudget(preferences, 'timeoutMs', Number(event.target.value)))
                      }
                    />
                  </label>
                  <label className={css.field}>
                    <span>{t('maxOutputTokens')}</span>
                    <input
                      className={css.input}
                      type="number"
                      data-opl-auto-review-budget="maxOutputTokens"
                      min={REVIEW_BUDGET_RANGE.maxOutputTokens.min}
                      max={REVIEW_BUDGET_RANGE.maxOutputTokens.max}
                      disabled={!editable}
                      value={String(preferences.maxOutputTokens)}
                      onChange={(event) =>
                        edit(withBudget(preferences, 'maxOutputTokens', Number(event.target.value)))
                      }
                    />
                  </label>
                </div>
                <p className={css.muted}>
                  {t('limitsRange', {
                    timeoutMin: REVIEW_BUDGET_RANGE.timeoutMs.min,
                    timeoutMax: REVIEW_BUDGET_RANGE.timeoutMs.max,
                    outputMin: REVIEW_BUDGET_RANGE.maxOutputTokens.min,
                    outputMax: REVIEW_BUDGET_RANGE.maxOutputTokens.max,
                  })}
                </p>
                {submittable ? null : (
                  <p className={css.error} role="alert">
                    {t('invalidNumber')}
                  </p>
                )}
              </div>

              <div className={css.card}>
                <h3 className={css.name}>{t('draftTitle')}</h3>
                <p className={css.muted} data-opl-auto-review-dirty={view.dirty ? 'true' : 'false'}>
                  {view.dirty ? t('draftDirty') : t('draftClean')}
                </p>
                <p className={css.muted}>{t('saveHint')}</p>
                <div className={css.actions}>
                  <Button
                    variant="outline"
                    size="sm"
                    data-opl-auto-review-refresh=""
                    disabled={view.reading || view.saving || !view.connected}
                    onClick={() => void store.load()}
                  >
                    {view.reading ? t('statusReloading') : t('refresh')}
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    data-opl-auto-review-save=""
                    disabled={saveDisabled}
                    title={saveTitleKey === undefined ? undefined : t(saveTitleKey)}
                    onClick={() => void store.save()}
                  >
                    {view.saving ? t('saving') : t('save')}
                  </Button>
                </div>
              </div>

              <p className={css.muted}>{t('hostTruthNote')}</p>
            </>
          )}
        </>
      )}
    </div>
  )
}
