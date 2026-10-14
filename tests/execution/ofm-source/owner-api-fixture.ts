/**
 * Isolated dummy owner-API fixture: an admitted caller over a fake plugin HTTP
 * surface shaped like the plugin's own `/api/our-free-model/clients` response.
 * Exercises admission, rotation, lane state and model withdrawal without a
 * network, a plugin, or a real key.
 */

/** A caller that answers the plugin's published clients route from memory. */
export function fixtureCaller(initial: Record<string, unknown> = {}) {
  const state = {
    status: 200,
    running: true,
    port: 32123,
    key: 'ofm-fixture-key-aaaaaaaaaaaaaaaaaaaaaaaa',
    models: ['mimo-v2.6-flash-free', 'moonshotai/kimi-k3'],
    ...initial,
  }
  const calls: { url: string; method?: string }[] = []
  const caller = async (request: { url: string; method?: string }) => {
    calls.push(request)
    if (state.status !== 200) return { status: state.status, body: { error: 'unauthorized' } }
    const origin = `http://127.0.0.1:${state.port}`
    return {
      status: 200,
      body: {
        running: state.running,
        // The plugin publishes a literal placeholder while the lane is down.
        baseUrl: state.running ? origin : 'http://127.0.0.1:<forward-port>',
        key: state.key,
        models: state.models,
        // Real recipes travel in this response. The reader must compose the base
        // itself and never parse or evaluate these.
        snippets: [
          { id: 'codex', body: `base_url = "${origin}/v1"` },
          { id: 'openai-sdk', body: `base_url="${origin}/v1"` },
          { id: 'claude-code', body: `export ANTHROPIC_BASE_URL=${origin}` },
        ],
      },
    }
  }
  return {
    caller,
    calls,
    state,
    rotate: () => {
      state.key = 'ofm-fixture-key-bbbbbbbbbbbbbbbbbbbbbbbb'
    },
    stop: () => {
      state.running = false
    },
    withdraw: (model: string) => {
      state.models = state.models.filter((m) => m !== model)
    },
  }
}
