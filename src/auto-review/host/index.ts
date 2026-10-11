/**
 * OPL Auto Review Host entry point.
 *
 * The default export is the Cordis plugin the suite mounts; the named exports
 * are everything a test or a sibling module needs without reaching into the
 * service instance.
 */
export {
  AUTO_REVIEW_SERVICE,
  EXTERNAL_REVIEW_BINDING_SERVICE,
  LEDGER_SERVICE,
  STORAGE_DOMAIN_SERVICE,
  OplAutoReviewService,
  OplAutoReviewService as default,
} from './service.ts'
export {
  AUTO_REVIEW_FIELD,
  AUTO_REVIEW_OWNER_NS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_PREFERENCES,
  DEFAULT_TIMEOUT_MS,
  MAX_MAX_OUTPUT_TOKENS,
  MAX_TIMEOUT_MS,
  MIN_MAX_OUTPUT_TOKENS,
  MIN_TIMEOUT_MS,
  Config,
  coerceServiceConfig,
  configFromPreferences,
  normalizePreferences,
  preferencesFromConfig,
  revisionOf,
  samePreferences,
} from './settings.ts'
export {
  EXCLUDED_REVIEW_PROVIDERS,
  OPENAI_AUTO_REVIEW_ROUTE,
  OPENAI_CODEX_MODEL_PREFIX,
  OPENAI_GATEWAY_PROVIDER,
  ReviewerRouteError,
  effortConfirmed,
  isExcludedReviewProvider,
  isOpenAiCodexRoute,
  listAdvertisedRoutes,
  matchingRoute,
  resolveExternalReviewerRoute,
  resolveReviewerRoute,
  reviewerRouteAvailability,
} from './routes.ts'
export {
  EXTERNAL_REVIEW_BLOCK_TEXT,
  EXTERNAL_REVIEW_HARNESSES,
  assessExternalReview,
  externalReviewUserText,
  installExternalReviewBridge,
  sameExternalReviewBinding,
} from './external-review.ts'
export { POLICY_VERSION, REVIEW_POLICY, parseDecision, readDecision } from './policy.ts'
export {
  AUTO_REVIEW_DOMAIN,
  AUTO_REVIEW_TABLE,
  autoReviewDomainSpec,
  createDomainLedger,
  reviewRecordKey,
  reviewRecordSchema,
  type ReviewLedger,
  type ReviewRecord,
} from './ledger.ts'
