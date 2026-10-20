/**
 * Pure preference helpers of the Auto Review settings section: comparison,
 * advertised-route lookup, and route normalization. No React, no network, and
 * no Host state — everything here is a total function over the shared DTO, so
 * the exact effort a save will carry is decided in one place.
 *
 * Route contract: the effort a fixed route carries is always one of the strings
 * the Host advertised for that exact provider/model pair. Nothing is invented,
 * and a pair the Host did not advertise cannot be selected.
 */
import type {
  AutoReviewPreferences,
  AutoReviewRoute,
  AutoReviewRouteOption,
} from '../contracts/settings.ts'

/** Structural equality of two preference values, including the reviewer route. */
export function samePreferences(a: AutoReviewPreferences, b: AutoReviewPreferences): boolean {
  return (
    a.enabled === b.enabled &&
    a.timeoutMs === b.timeoutMs &&
    a.maxOutputTokens === b.maxOutputTokens &&
    sameReviewer(a, b)
  )
}

function sameReviewer(a: AutoReviewPreferences, b: AutoReviewPreferences): boolean {
  if (a.reviewer.mode !== b.reviewer.mode) return false
  if (a.reviewer.mode === 'current' || b.reviewer.mode === 'current') return true
  return (
    a.reviewer.route.provider === b.reviewer.route.provider &&
    a.reviewer.route.model === b.reviewer.route.model &&
    a.reviewer.route.reasoningEffort === b.reviewer.route.reasoningEffort
  )
}

/** Stable key of one advertised provider/model pair. */
export function routeKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`
}

/** The advertised option for one provider/model pair, if the Host offers it. */
export function findRoute(
  routes: readonly AutoReviewRouteOption[],
  provider: string,
  model: string,
): AutoReviewRouteOption | undefined {
  return routes.find((route) => route.provider === provider && route.model === model)
}

/**
 * The advertised effort to preselect for one option.
 *
 * `defaultEffort` wins only when it is actually advertised; otherwise the first
 * advertised effort is used. An option advertising no effort yields `undefined`,
 * so the route omits `reasoningEffort` rather than carrying an invented value.
 */
export function advertisedEffort(option: AutoReviewRouteOption): string | undefined {
  if (option.defaultEffort !== null && option.efforts.includes(option.defaultEffort))
    return option.defaultEffort
  return option.efforts[0]
}

/** Build the fixed reviewer route of one advertised option. */
export function routeFromOption(option: AutoReviewRouteOption): AutoReviewRoute {
  const effort = advertisedEffort(option)
  return {
    provider: option.provider,
    model: option.model,
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
  }
}

/**
 * Apply one advertised option to a draft, keeping the effort only when the new
 * pair still advertises it; otherwise the option's own advertised effort wins.
 */
export function withFixedRoute(
  preferences: AutoReviewPreferences,
  option: AutoReviewRouteOption,
  mode: 'fixed' | 'decision' = 'fixed',
): AutoReviewPreferences {
  const current =
    preferences.reviewer.mode === 'fixed' || preferences.reviewer.mode === 'decision'
      ? preferences.reviewer.route
      : undefined
  const effort =
    current !== undefined &&
    current.provider === option.provider &&
    current.model === option.model &&
    current.reasoningEffort !== undefined &&
    option.efforts.includes(current.reasoningEffort)
      ? current.reasoningEffort
      : advertisedEffort(option)
  return {
    ...preferences,
    reviewer: {
      mode,
      route: {
        provider: option.provider,
        model: option.model,
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
      },
    },
  }
}

/** Switch a draft back to the current native Session route. */
export function withCurrentRoute(preferences: AutoReviewPreferences): AutoReviewPreferences {
  return { ...preferences, reviewer: { mode: 'current' } }
}

/**
 * Set the effort of the currently fixed route to one advertised string.
 *
 * A value the route does not advertise is ignored rather than sent, so the
 * request can never carry an effort the Host did not offer.
 */
export function withFixedEffort(
  preferences: AutoReviewPreferences,
  routes: readonly AutoReviewRouteOption[],
  effort: string,
): AutoReviewPreferences {
  if (preferences.reviewer.mode !== 'fixed' && preferences.reviewer.mode !== 'decision')
    return preferences
  const route = preferences.reviewer.route
  const option = findRoute(routes, route.provider, route.model)
  if (!option || !option.efforts.includes(effort)) return preferences
  return {
    ...preferences,
    reviewer: {
      mode: preferences.reviewer.mode,
      route: { provider: route.provider, model: route.model, reasoningEffort: effort },
    },
  }
}

/** Set one budget field, leaving every other preference untouched. */
export function withBudget(
  preferences: AutoReviewPreferences,
  field: 'timeoutMs' | 'maxOutputTokens',
  value: number,
): AutoReviewPreferences {
  return { ...preferences, [field]: value }
}

/**
 * Whether a draft may be submitted at all.
 *
 * Only a client-readable impossibility blocks submission (a non-number or a
 * non-positive budget): those cannot be serialized into the save request. The
 * saveable range stays the Host's decision, which answers `invalid-settings`.
 */
export function budgetIsSubmittable(preferences: AutoReviewPreferences): boolean {
  return (
    Number.isFinite(preferences.timeoutMs) &&
    preferences.timeoutMs > 0 &&
    Number.isFinite(preferences.maxOutputTokens) &&
    preferences.maxOutputTokens > 0
  )
}
