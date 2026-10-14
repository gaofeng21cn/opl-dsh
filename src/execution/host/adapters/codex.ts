import { nativeAvailable, prepareNative } from './native.ts'
import type { HarnessAdapter } from './types.ts'
import { OFM_PROVIDER } from '../ofm-source/provider.ts'

const OFM_CODEX_MODEL = 'openai/gpt-oss-20b'

const matchesOfmCodexModel = (provider: string, model: string): boolean =>
  provider === OFM_PROVIDER && model === OFM_CODEX_MODEL
export const codexAdapter: HarnessAdapter = {
  id: 'codex',
  transport: 'acp',
  capabilities: {
    transport: 'app-server',
    authentication: 'api-source',
    protocols: ['responses'],
    customEndpoint: true,
    permissions: ['read-only', 'workspace', 'full-access'],
    sessionLoad: true,
    cancel: true,
    reasoning: 'model-declared',
    autoReview: 'official',
  },
  matches: (ref) =>
    (ref.provider === 'opl-gateway' && ref.model.startsWith('codex::gpt-')) ||
    matchesOfmCodexModel(ref.provider, ref.model),
  available: (_ctx, options) => nativeAvailable('Codex CLI', 'codex', options),
  prepare: (ctx, record, options) =>
    prepareNative(ctx, record, options, (home) => ({ CODEX_HOME: home })),
}
