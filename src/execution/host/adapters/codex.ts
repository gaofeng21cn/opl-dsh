import { nativeAvailable, prepareNative } from './native.ts'
import type { HarnessAdapter } from './types.ts'
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
  matches: (ref) => ref.provider === 'opl-gateway' && ref.model.startsWith('codex::gpt-'),
  available: (_ctx, options) => nativeAvailable('Codex CLI', 'codex', options),
  prepare: (ctx, record, options) =>
    prepareNative(ctx, record, options, (home) => ({ CODEX_HOME: home })),
}
