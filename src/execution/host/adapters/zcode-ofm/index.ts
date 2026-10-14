/**
 * Official ZCode CLI adapter surface for the Our Free Model route.
 *
 * Everything this route contributes to the suite is exported here, so the shared
 * adapter registry, the suite catalog and the model source owner can consume it
 * without reaching into the module layout. Nothing in this directory touches the
 * official application, a shared contract, a shared DTO, or a user's credentials, and
 * it adds no settings page: credentials stay with the model source, the program stays
 * with the existing execution-engine entry, and the binding stays with the execution
 * combination.
 *
 * Integration for the packager is additive and consists of:
 *
 * - adding {@link zcodeOfmAdapter} to the adapter registry. It shares the `zcode`
 *   harness id with the existing Huawei MaaS route on purpose — one ZCode engine, two
 *   routes — so the registry entry must sit **after** `withZcodePermissions(zcodeAdapter)`
 *   and before the `dsh` entry; the Huawei adapter's `customEndpoint: false` and its
 *   exact `matches()` keep that route untouched either way;
 * - declaring the pairing in the **central** Our Free Model source, not here. This
 *   module deliberately registers nothing: a second registration for the same
 *   `our-free-model` provider would either be refused as a duplicate or shadow the
 *   central source for every other Harness. The central module needs two entries —
 *   `zcode: 'chat'` in its protocol table and this route's exact model set in its
 *   pinned-model table — after which this adapter consumes it through
 *   `options.modelSources` and nothing more;
 * - emitting the owned bridge as a separate module next to the bundled host, the same
 *   way `zcode-harness-bridge.mjs` already is (see {@link zcodeOfmBridgePath});
 * - advertising nothing new: the harness already appears in the execution-engine entry
 *   through the existing `zcode` definition, so detection, maintenance and removal all
 *   keep working unchanged.
 *
 * @module zcode-ofm/index
 */

export {
  zcodeOfmAdapter,
  zcodeOfmBashEnvironment,
  zcodeOfmBridgePath,
  OFM_CREDENTIAL_REQUESTS,
} from './zcode-ofm.ts'
export {
  OFM_MODEL_PROPERTIES,
  OFM_RELAY_HOST,
  OFM_RELAY_MAX_BODY_BYTES,
  OFM_RELAY_PLACEHOLDER_KEY,
  OFM_RELAY_TICKET_HEADER,
  OFM_ZCODE_PROVIDER_ID,
  OFM_ZCODE_PROVIDER_NAME,
  ZCODE_OFM_DEFAULT_REASONING_LEVEL,
  ZCODE_OFM_HARNESS,
  ZCODE_OFM_MODELS,
  ZCODE_OFM_PROVIDER_ID,
  ZCODE_OFM_REASONING_LEVELS,
  ZCODE_OFM_WIRE_PROTOCOL,
  assertOfmModelSelection,
  assertOfmRoute,
  buildBuiltinProviderConfig,
  buildOfmPersonalProviderConfig,
  isZcodeOfmModel,
  isZcodeOfmRef,
  ofmModelSelection,
  zcodeOfmReasoningLevel,
  type ZcodeOfmModel,
  type ZcodeOfmReasoningLevel,
} from './zcode-ofm-models.ts'
export { startOfmRelay, type OfmRelay, type OfmRelayTarget } from './zcode-ofm-relay.ts'
