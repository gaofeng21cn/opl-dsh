/** Stage at which an update operation failed. */
export type UpdateFailureStage =
  | 'acquire'
  | 'installation'
  | 'discovery'
  | 'download'
  | 'verify'
  | 'stage'
  | 'confirm'
  | 'cancel'
  | 'apply'
  | 'save'

/** Safe, user-actionable reason for an update failure. */
export type UpdateFailureReason =
  | 'network'
  | 'proxy'
  | 'timeout'
  | 'http'
  | 'integrity'
  | 'busy'
  | 'installation'
  | 'release-changed'
  | 'filesystem'
  | 'unknown'

/** Bounded details suitable for persistence or a renderer status. */
export interface UpdateFailureDetails {
  readonly stage: UpdateFailureStage
  readonly reason: UpdateFailureReason
  readonly httpStatus?: number
  readonly systemCode?: string
}

/**
 * Describe an arbitrary failure using only bounded, allow-listed fields.
 * @param error Failure value from an update operation.
 * @param stage Fallback operation stage.
 * @returns Safe failure details.
 */
export function describeUpdateFailure(
  error: unknown,
  stage: UpdateFailureStage,
): UpdateFailureDetails

/**
 * Error carrying safe details while retaining the original cause and message.
 * @param error Failure value from an update operation.
 * @param stage Operation stage.
 * @param reason Explicit reason.
 * @returns Typed failure with bounded details.
 */
export function updateFailureError(
  error: unknown,
  stage: UpdateFailureStage,
  reason?: UpdateFailureReason,
): Error & { readonly updateFailure: UpdateFailureDetails }
