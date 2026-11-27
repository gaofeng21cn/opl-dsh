import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'
import type { Context } from '@deepseek-ai/cordis'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { Config as PiAiConfig } from '@deepseek-ai/dsh-llm-pi-ai'
import { redactSecrets } from '@deepseek-ai/dsh-settings'
import { DEFAULT_GATEWAY_CHANNELS } from '../../src/gateway/host/channel-defaults.ts'
import { LEGACY_GATEWAY_PI_AI_PROVIDERS } from '../../src/gateway/contracts/groups.ts'
import {
  editGatewayModels,
  syncGatewayModels,
  discoverGatewayModels,
  gatewayModelSettings,
  migrateLegacyGatewaySettings,
} from '../../src/gateway/host/model-settings.ts'
import { Config as SuiteConfig } from '../../src/suite/config.ts'

function fixture({
  officialRedaction = false,
  includePiAi = false,
}: { officialRedaction?: boolean; includePiAi?: boolean } = {}) {
  const state: any = {
    'opl-suite': {
      gateway: { models: [{ id: 'deepseek-flash', name: 'DeepSeek' }] },
      gatewayCatalogHashes: {},
      gatewayChannels: {},
    },
    ...(includePiAi
      ? {
          'llm-pi-ai': {
            providers: {},
          },
        }
      : {}),
  }
  const users: any = {
    'opl-suite': {
      gateway: { models: [{ id: 'deepseek-flash', name: 'DeepSeek' }] },
      gatewayChannels: {},
    },
    ...(includePiAi ? { 'llm-pi-ai': { providers: {} } } : {}),
  }
  const revisions: Record<string, number> = {
    'opl-suite': 0,
    ...(includePiAi ? { 'llm-pi-ai': 0 } : {}),
  }
  const set = (root: any, path: readonly string[], value: unknown) => {
    for (const key of path.slice(0, -1)) root = root[key] ??= {}
    root[path.at(-1)!] = structuredClone(value)
  }
  const unset = (root: any, path: readonly string[]) => {
    for (const key of path.slice(0, -1)) {
      if (!root || typeof root !== 'object') return
      root = root[key]
    }
    if (root && typeof root === 'object') delete root[path.at(-1)!]
  }
  const applyOp = (root: any, op: any) => {
    if (op.op === 'unset') unset(root, op.path)
    else set(root, op.path, op.value)
  }
  const settings = {
    describe: (options?: { redactSecrets?: boolean }) =>
      Object.entries(state).map(([ns, value]) => {
        const descriptor = {
          ns,
          value,
          base: {},
          user: users[ns],
          revision: revisions[ns],
        }
        if (!officialRedaction || !options?.redactSecrets) return descriptor
        const schema =
          ns === 'opl-suite' ? SuiteConfig : ns === 'llm-pi-ai' ? PiAiConfig : undefined
        if (!schema) return descriptor
        return {
          ...descriptor,
          value: redactSecrets(schema, descriptor.value).value,
          base: redactSecrets(schema, descriptor.base).value,
          user: redactSecrets(schema, descriptor.user).value,
        }
      }),
    mutate: vi.fn(async (ns: string, ops: any[], revision?: number) => {
      if (revision !== undefined && revision !== revisions[ns]) throw Error('conflict')
      for (const op of ops) {
        applyOp(state[ns], op)
        applyOp(users[ns], op)
      }
      revisions[ns]++
    }),
  }
  const discover = vi.fn(async (..._args: unknown[]) => [{ id: 'gpt-new' }])
  const keys = new Map([['OPL_GATEWAY_CODEX_API_KEY', 'fixture']])
  const credentials = {
    resolve: vi.fn(async (ref: string) => (keys.has(ref) ? { value: keys.get(ref)! } : undefined)),
  }
  const account = { status: async () => ({ groups: [{ id: 'codex', state: 'ready' }] }) }
  const ctx = {
    settings,
    credentials,
    llm: {
      listConfigurableProviders: () => [],
      discoverModels: discover,
    },
    get: (name: string) =>
      name === 'settings'
        ? settings
        : name === 'credentials'
          ? credentials
          : name === 'llm'
            ? ctx.llm
            : name === 'oplGatewayAccount'
              ? account
              : undefined,
    logger: { warn: vi.fn() },
  } as unknown as Context
  return { ctx, state, users, revisions, settings, discover, credentials, keys }
}

it('keeps cordis.patch.yml free of llm-pi-ai and ships current Gemini defaults in code', async () => {
  const patch = parse(await readFile(new URL('../../cordis.patch.yml', import.meta.url), 'utf8'))
  expect(patch.find((entry: { id: string }) => entry.id === 'llm-pi-ai')).toBeUndefined()
  expect(DEFAULT_GATEWAY_CHANNELS.gemini.models!.map((model) => model.id)).toEqual([
    'gemini-4-carbon',
    'gemini-4-hydrogen',
  ])
})

describe('native model settings authority', () => {
  it('writes DeepSeek edits to the actual adapter config and keeps an explicitly empty list', async () => {
    const f = fixture({ includePiAi: true })
    await editGatewayModels(f.ctx, { group: 'deepseek', revision: 0, models: [] })
    expect(f.state['opl-suite'].gateway.models).toEqual([])
    expect(f.state['llm-pi-ai'].providers['opl-gateway']).toBeUndefined()
  })

  it('writes Codex edits into opl-suite.gatewayChannels without touching llm-pi-ai', async () => {
    const f = fixture({ includePiAi: true })
    await editGatewayModels(f.ctx, {
      group: 'codex',
      revision: 0,
      api: 'openai-completions',
      models: [{ id: 'same-id' }],
    })
    expect(f.state['opl-suite'].gatewayChannels.codex).toMatchObject({
      models: [{ id: 'same-id' }],
      api: 'openai-completions',
    })
    expect(f.state['llm-pi-ai'].providers).toEqual({})
  })

  it('rejects stale edits and duplicate identities', async () => {
    const f = fixture()
    await expect(
      editGatewayModels(f.ctx, { group: 'deepseek', revision: 9, models: [] }),
    ).rejects.toThrow('conflict')
    await expect(
      editGatewayModels(f.ctx, {
        group: 'codex',
        revision: 0,
        api: 'openai-responses',
        models: [{ id: 'a' }, { id: 'a' }],
      }),
    ).rejects.toThrow('重复')
  })

  it('refreshes automatic imports but preserves a later manual model list', async () => {
    const f = fixture()
    await syncGatewayModels(f.ctx)
    expect(f.state['opl-suite'].gatewayChannels.codex.models).toEqual([{ id: 'gpt-new' }])
    f.discover.mockResolvedValue([{ id: 'gpt-next' }])
    await syncGatewayModels(f.ctx)
    expect(f.state['opl-suite'].gatewayChannels.codex.models).toEqual([{ id: 'gpt-next' }])
    await editGatewayModels(f.ctx, {
      group: 'codex',
      revision: f.revisions['opl-suite']!,
      api: 'openai-responses',
      models: [{ id: 'chosen' }],
    })
    await syncGatewayModels(f.ctx)
    expect(f.state['opl-suite'].gatewayChannels.codex.models).toEqual([{ id: 'chosen' }])
    expect(f.discover).toHaveBeenCalledTimes(2)
  })

  it('does not auto-import DeepSeek Flash into the optional OpenAI protocol route', async () => {
    const f = fixture()
    f.discover.mockResolvedValue([{ id: 'deepseek-flash' }, { id: 'gpt-new' }])
    await syncGatewayModels(f.ctx)
    expect(f.state['opl-suite'].gatewayChannels.codex.models).toEqual([{ id: 'gpt-new' }])
  })
})

describe('legacy llm-pi-ai to opl-suite migration', () => {
  it('migrates customized gateway channels losslessly into opl-suite, clears all legacy keys including auto-review, preserves third-party providers, and is idempotent', async () => {
    const f = fixture({ includePiAi: true, officialRedaction: true })
    const customCodex = {
      displayName: 'Custom Codex',
      api: 'openai-completions',
      baseURL: 'https://tenant.invalid/v1',
      apiKeyEnv: 'CUSTOM_CODEX_KEY',
      models: [
        {
          id: 'gpt-custom',
          name: 'Custom GPT',
          input: ['text'],
          metadata: { nested: [true, null] },
        },
      ],
    }
    const awsOld = opusProfile('aws')
    const thirdParty = {
      api: 'anthropic-messages',
      baseURL: 'https://api.custom-third-party.invalid',
      apiKeyEnv: 'THIRD_PARTY_KEY',
      models: [{ id: 'third-party-model' }],
    }
    f.users['llm-pi-ai'].providers = {
      'opl-gateway-openai': structuredClone(customCodex),
      'opl-gateway-aws': structuredClone(awsOld),
      'opl-gateway-auto-review': {
        api: 'openai-responses',
        baseURL: 'https://gateway.medopl.com/v1',
        apiKeyEnv: 'OPL_GATEWAY_CODEX_API_KEY',
        models: [{ id: 'codex-auto-review' }],
      },
      'custom-third-party': structuredClone(thirdParty),
    }
    f.state['llm-pi-ai'].providers = structuredClone(f.users['llm-pi-ai'].providers)

    await migrateLegacyGatewaySettings(f.ctx)

    expect(f.state['opl-suite'].gatewayChannels.codex).toEqual(customCodex)
    expect(f.state['opl-suite'].gatewayChannels.aws).toMatchObject({
      baseURL: 'https://gateway.medopl.com',
      apiKeyEnv: 'OPL_GATEWAY_AWS_API_KEY',
      models: [
        {
          id: 'claude-opus-5-5',
          compat: { forceAdaptiveThinking: true },
          input: ['text', 'image'],
        },
      ],
    })
    for (const legacyKey of LEGACY_GATEWAY_PI_AI_PROVIDERS) {
      expect(f.state['llm-pi-ai'].providers[legacyKey]).toBeUndefined()
      expect(f.users['llm-pi-ai'].providers[legacyKey]).toBeUndefined()
    }
    expect(f.state['llm-pi-ai'].providers['custom-third-party']).toEqual(thirdParty)
    expect(f.users['llm-pi-ai'].providers['custom-third-party']).toEqual(thirdParty)

    const mutationsAfterFirstRun = f.settings.mutate.mock.calls.length
    await migrateLegacyGatewaySettings(f.ctx)
    expect(f.settings.mutate).toHaveBeenCalledTimes(mutationsAfterFirstRun)
  })

  it('does not overwrite an already migrated channel in opl-suite when legacy llm-pi-ai keys exist', async () => {
    const f = fixture({ includePiAi: true })
    const newerCodex = {
      api: 'openai-responses',
      baseURL: 'https://gateway.medopl.com/v1',
      apiKeyEnv: 'OPL_GATEWAY_CODEX_API_KEY',
      models: [{ id: 'gpt-6.2-astra', input: ['text', 'image'] }],
    }
    f.users['opl-suite'].gatewayChannels.codex = structuredClone(newerCodex)
    f.state['opl-suite'].gatewayChannels.codex = structuredClone(newerCodex)
    f.users['llm-pi-ai'].providers = {
      'opl-gateway-openai': {
        api: 'openai-completions',
        baseURL: 'https://stale.invalid/v1',
        models: [{ id: 'stale-model' }],
      },
    }
    f.state['llm-pi-ai'].providers = structuredClone(f.users['llm-pi-ai'].providers)

    await migrateLegacyGatewaySettings(f.ctx)

    expect(f.state['opl-suite'].gatewayChannels.codex).toEqual(newerCodex)
    expect(f.state['llm-pi-ai'].providers['opl-gateway-openai']).toBeUndefined()
  })
})

describe('Gateway discovery presentation', () => {
  it('prefers the configured general ID over an unselected version ID without rewriting saved identities', async () => {
    const { gatewayModelChoices } = await import('../../src/gateway/shared/model-choices.ts')
    const version = { id: 'deepseek-v4.1-flash' },
      current = { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' }
    expect(gatewayModelChoices([version, current], [current])).toEqual([current])
    expect(gatewayModelChoices([version], [])).toEqual([version])
    expect(gatewayModelChoices([version, current], [version])).toEqual([version, current])
  })
})

const fingerprint = (models: unknown) =>
  createHash('sha256').update(JSON.stringify(models)).digest('hex')

function opusProfile(group: 'aws' | 'kiro') {
  return {
    displayName: `OPL Gateway · ${group === 'aws' ? 'AWS' : 'Kiro'}`,
    api: 'anthropic-messages',
    baseURL: 'https://gateway.medopl.com/v1',
    apiKeyEnv: `OPL_GATEWAY_${group.toUpperCase()}_API_KEY`,
    models: [
      {
        id: 'claude-opus-5-5',
        name: 'Claude Opus 5.5',
        reasoningEfforts: {
          low: 'low',
          medium: 'medium',
          high: 'high',
          xhigh: 'xhigh',
          max: 'max',
        },
      },
    ],
  }
}

describe('protocol prefixes and bundle-owned migration', () => {
  it('coalesces startup and account-refresh migrations without a competing revision write', async () => {
    const f = fixture()
    const aws = opusProfile('aws')
    f.state['opl-suite'].gatewayChannels.aws = structuredClone(aws)
    f.users['opl-suite'].gatewayChannels.aws = structuredClone(aws)
    await Promise.all([migrateLegacyGatewaySettings(f.ctx), migrateLegacyGatewaySettings(f.ctx)])
    expect(f.state['opl-suite'].gatewayChannels.aws).toMatchObject({
      baseURL: 'https://gateway.medopl.com',
      models: [{ id: 'claude-opus-5-5', compat: { forceAdaptiveThinking: true } }],
    })
    expect(f.settings.mutate).toHaveBeenCalledTimes(1)
  })

  it('refreshes approved automatic inputs and retains catalog hash ownership', async () => {
    const f = fixture()
    const profile = {
      ...structuredClone(DEFAULT_GATEWAY_CHANNELS.codex),
      models: [
        { id: 'gpt-6-astra', name: 'Chosen label', custom: { nested: [null, true] } },
        { id: 'gpt-6.1-sol', input: ['text'] },
        { id: 'gpt-6.1-terra' },
      ],
    }
    f.state['opl-suite'].gatewayChannels.codex = structuredClone(profile)
    f.users['opl-suite'].gatewayChannels.codex = structuredClone(profile)
    f.state['opl-suite'].gatewayCatalogHashes.codex = fingerprint(profile.models)
    await migrateLegacyGatewaySettings(f.ctx)
    expect(f.state['opl-suite'].gatewayChannels.codex.models).toEqual([
      {
        id: 'gpt-6-astra',
        name: 'Chosen label',
        custom: { nested: [null, true] },
        input: ['text', 'image'],
      },
      { id: 'gpt-6.1-sol', input: ['text', 'image'] },
      { id: 'gpt-6.1-terra', input: ['text', 'image'] },
    ])
    expect(f.state['opl-suite'].gatewayCatalogHashes.codex).toBe(
      fingerprint(f.state['opl-suite'].gatewayChannels.codex.models),
    )
    await migrateLegacyGatewaySettings(f.ctx)
    expect(f.settings.mutate).toHaveBeenCalledTimes(1)
  })

  it('retains automatic ownership across SuiteConfig secret redaction and lossless fields', async () => {
    const f = fixture({ officialRedaction: true })
    const raw = {
      ...structuredClone(DEFAULT_GATEWAY_CHANNELS.codex),
      models: [
        {
          id: 'gpt-6.1-sol',
          input: ['text'],
          inputModalities: ['text'],
          custom: { nested: [null, true] },
        },
      ],
    }
    f.users['opl-suite'].gatewayChannels = { codex: structuredClone(raw) }
    f.state['opl-suite'].gatewayChannels = { codex: structuredClone(raw) }
    f.state['opl-suite'].gatewayCatalogHashes.codex = fingerprint(raw.models)
    const redacted = f.settings
      .describe({ redactSecrets: true })
      .find((item) => item.ns === 'opl-suite')!
    expect(redacted.user.gatewayChannels.codex.models).toEqual(raw.models)
    await migrateLegacyGatewaySettings(f.ctx)
    const expected = [{ ...raw.models[0], input: ['text', 'image'] }]
    expect(f.state['opl-suite'].gatewayChannels.codex.models).toEqual(expected)
    expect(f.state['opl-suite'].gatewayCatalogHashes.codex).toBe(fingerprint(expected))
    await migrateLegacyGatewaySettings(f.ctx)
    expect(f.settings.mutate).toHaveBeenCalledTimes(1)
  })

  it.each([
    { name: 'Chosen label' },
    { input: ['text', 'image'] },
    { custom: { nested: [null, false] } },
  ])('retains a user-modified catalog after official redaction: %j', async (change) => {
    const f = fixture({ officialRedaction: true })
    const original = {
      id: 'gpt-6.1-sol',
      input: ['text'],
      name: 'Automatic label',
      custom: { nested: [null, true] },
    }
    const raw = {
      ...structuredClone(DEFAULT_GATEWAY_CHANNELS.codex),
      models: [{ ...original, ...change }],
    }
    f.users['opl-suite'].gatewayChannels = { codex: structuredClone(raw) }
    f.state['opl-suite'].gatewayChannels = { codex: structuredClone(raw) }
    const previous = fingerprint([original])
    f.state['opl-suite'].gatewayCatalogHashes.codex = previous
    const before = structuredClone(f.state['opl-suite'].gatewayChannels)
    await migrateLegacyGatewaySettings(f.ctx)
    expect(f.state['opl-suite'].gatewayChannels).toEqual(before)
    expect(f.state['opl-suite'].gatewayCatalogHashes.codex).toBe(previous)
    expect(f.settings.mutate).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'uses the saved catalog hash for automatic sync after redaction; user changed: %s',
    async (changed) => {
      const f = fixture({ officialRedaction: true })
      const original = {
        id: 'gpt-custom',
        input: ['text'],
        name: 'Automatic label',
        custom: { nested: [null, true] },
      }
      const models = [{ ...original, ...(changed ? { name: 'Chosen label' } : {}) }]
      const raw = {
        ...structuredClone(DEFAULT_GATEWAY_CHANNELS.codex),
        models,
      }
      f.users['opl-suite'].gatewayChannels = { codex: structuredClone(raw) }
      f.state['opl-suite'].gatewayChannels = { codex: structuredClone(raw) }
      const previous = fingerprint([original])
      f.state['opl-suite'].gatewayCatalogHashes.codex = previous
      f.discover.mockResolvedValue([{ id: 'gpt-next' }])
      await syncGatewayModels(f.ctx)
      const expected = changed ? models : [{ id: 'gpt-next' }]
      expect(f.users['opl-suite'].gatewayChannels.codex.models).toEqual(expected)
      expect(f.state['opl-suite'].gatewayCatalogHashes.codex).toBe(
        changed ? previous : fingerprint(expected),
      )
      expect(f.discover).toHaveBeenCalledTimes(changed ? 0 : 1)
    },
  )

  it.each([
    { defaultInput: ['text'] },
    { baseURL: 'https://tenant.invalid/v1' },
    { apiKeyEnv: 'CUSTOM_KEY' },
    { api: 'openai-completions' },
  ])(
    'preserves saved input policy or custom connection with a matching catalog hash: %j',
    async (choice) => {
      const f = fixture({ officialRedaction: true })
      const raw = {
        ...structuredClone(DEFAULT_GATEWAY_CHANNELS.codex),
        ...choice,
        models: [{ id: 'gpt-6.1-sol', input: ['text'] }],
      }
      f.users['opl-suite'].gatewayChannels = { codex: structuredClone(raw) }
      f.state['opl-suite'].gatewayChannels = { codex: structuredClone(raw) }
      f.state['opl-suite'].gatewayCatalogHashes.codex = fingerprint(raw.models)
      const before = structuredClone(f.state['opl-suite'].gatewayChannels)
      await migrateLegacyGatewaySettings(f.ctx)
      expect(f.state['opl-suite'].gatewayChannels).toEqual(before)
      expect(f.settings.mutate).not.toHaveBeenCalled()
    },
  )

  it('preserves explicit saved text inputs after the automatic catalog hash changes', async () => {
    const f = fixture()
    const raw = {
      ...structuredClone(DEFAULT_GATEWAY_CHANNELS.codex),
      models: [{ id: 'gpt-6.1-sol', input: ['text'] }],
    }
    f.users['opl-suite'].gatewayChannels = { codex: structuredClone(raw) }
    f.state['opl-suite'].gatewayChannels = { codex: structuredClone(raw) }
    f.state['opl-suite'].gatewayCatalogHashes.codex = 'previous-automatic-catalog'
    await migrateLegacyGatewaySettings(f.ctx)
    expect(f.users['opl-suite'].gatewayChannels.codex.models).toEqual(raw.models)
    expect(f.state['opl-suite'].gatewayCatalogHashes.codex).toBe('previous-automatic-catalog')
    expect(f.settings.mutate).not.toHaveBeenCalled()
  })

  it('does not materialize settings writes when gatewayChannels has no user override', async () => {
    const f = fixture()
    f.state['opl-suite'].gatewayCatalogHashes.codex = 'some-hash'
    await migrateLegacyGatewaySettings(f.ctx)
    expect(f.settings.mutate).not.toHaveBeenCalled()
  })

  it('applies missing input defaults during discovery and editing of a defaulted live route', async () => {
    const f = fixture()
    f.discover.mockResolvedValue([{ id: 'gpt-6.1-sol' }])
    expect(await discoverGatewayModels(f.ctx, { group: 'codex' })).toEqual([
      { id: 'gpt-6.1-sol', input: ['text', 'image'] },
    ])
    await editGatewayModels(f.ctx, {
      group: 'codex',
      api: 'openai-responses',
      revision: f.revisions['opl-suite']!,
      models: [{ id: 'gpt-6.1-sol' }],
    })
    expect(f.users['opl-suite'].gatewayChannels.codex.models).toEqual([
      { id: 'gpt-6.1-sol', input: ['text', 'image'] },
    ])
  })

  it.each(['aws', 'kiro'] as const)(
    'creates %s with the SDK root and updates only an owned prefix on protocol changes',
    async (group) => {
      const f = fixture()
      await editGatewayModels(f.ctx, {
        group,
        revision: 0,
        api: 'anthropic-messages',
        models: [{ id: 'custom' }],
      })
      expect(f.state['opl-suite'].gatewayChannels[group].baseURL).toBe('https://gateway.medopl.com')
      await editGatewayModels(f.ctx, {
        group,
        revision: 1,
        api: 'openai-responses',
        models: f.state['opl-suite'].gatewayChannels[group].models,
      })
      expect(f.state['opl-suite'].gatewayChannels[group].baseURL).toBe(
        'https://gateway.medopl.com/v1',
      )
      await editGatewayModels(f.ctx, {
        group,
        revision: 2,
        api: 'anthropic-messages',
        models: f.state['opl-suite'].gatewayChannels[group].models,
      })
      expect(f.state['opl-suite'].gatewayChannels[group].baseURL).toBe('https://gateway.medopl.com')
    },
  )

  it.each([
    ['codex', 'openai-responses', 'gpt-6.1-terra'],
    ['gemini', 'openai-completions', 'gemini-4-carbon'],
    ['gemini', 'openai-completions', 'gemini-4-hydrogen'],
    ['gemini', 'openai-completions', 'gemini-4-argon'],
    ['gemini', 'openai-completions', 'gemini-3.8-flash'],
  ])(
    'completes an explicitly selected %s model on a newly created route: %s/%s',
    async (group, api, id) => {
      const f = fixture()
      await editGatewayModels(f.ctx, { group, api, revision: 0, models: [{ id }] })
      expect(f.state['opl-suite'].gatewayChannels[group].models).toEqual([
        { id, input: ['text', 'image'] },
      ])
    },
  )

  it.each([
    [
      { id: 'gemini-4-carbon', name: 'Gemini 4 Carbon', input: ['text', 'image'] },
      { id: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen', input: ['text', 'image'] },
    ],
    [
      { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro' },
      { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
    ],
    [
      { id: 'gemini-4-argon', name: 'Gemini 4 Argon' },
      { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
      { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro' },
    ],
  ])(
    'upgrades an untouched legacy Gemini catalog to Carbon and Hydrogen: %j',
    async (...legacyModels) => {
      const f = fixture()
      const profile = {
        displayName: 'OPL Gateway · Gemini',
        api: 'openai-completions',
        baseURL: 'https://gateway.medopl.com/v1',
        apiKeyEnv: 'OPL_GATEWAY_GEMINI_API_KEY',
        models: legacyModels,
      }
      f.state['opl-suite'].gatewayChannels.gemini = profile
      f.users['opl-suite'].gatewayChannels.gemini = structuredClone(profile)
      await migrateLegacyGatewaySettings(f.ctx)
      expect(f.state['opl-suite'].gatewayChannels.gemini.models).toEqual([
        { id: 'gemini-4-carbon', name: 'Gemini 4 Carbon', input: ['text', 'image'] },
        { id: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen', input: ['text', 'image'] },
      ])
      await migrateLegacyGatewaySettings(f.ctx)
      expect(f.settings.mutate).toHaveBeenCalledTimes(
        legacyModels[0]?.id === 'gemini-4-carbon' ? 0 : 1,
      )
    },
  )

  it('preserves an edited Gemini catalog even when its model IDs match the old defaults', async () => {
    const f = fixture()
    const profile = {
      displayName: 'OPL Gateway · Gemini',
      api: 'openai-completions',
      baseURL: 'https://gateway.medopl.com/v1',
      apiKeyEnv: 'OPL_GATEWAY_GEMINI_API_KEY',
      models: [
        { id: 'gemini-4-carbon', name: 'Preferred Carbon', input: ['text'] },
        { id: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen', input: ['text', 'image'] },
      ],
    }
    f.state['opl-suite'].gatewayChannels.gemini = profile
    f.users['opl-suite'].gatewayChannels.gemini = structuredClone(profile)

    await migrateLegacyGatewaySettings(f.ctx)

    expect(f.settings.mutate).not.toHaveBeenCalled()
  })

  it('does not replace a custom Gemini catalog', async () => {
    const f = fixture()
    const profile = {
      displayName: 'Custom Gemini',
      api: 'openai-completions',
      baseURL: 'https://tenant.invalid/v1',
      apiKeyEnv: 'CUSTOM_GEMINI_KEY',
      models: [{ id: 'gemini-3.8-flash', name: 'Custom Flash' }],
    }
    f.state['opl-suite'].gatewayChannels.gemini = profile
    f.users['opl-suite'].gatewayChannels.gemini = structuredClone(profile)
    await migrateLegacyGatewaySettings(f.ctx)
    expect(f.state['opl-suite'].gatewayChannels.gemini.models).toEqual(profile.models)
  })

  it('does not replace the Gemini catalog when it contains a custom model', async () => {
    const f = fixture()
    const profile = {
      displayName: 'OPL Gateway · Gemini',
      api: 'openai-completions',
      baseURL: 'https://gateway.medopl.com/v1',
      apiKeyEnv: 'OPL_GATEWAY_GEMINI_API_KEY',
      models: [
        { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro' },
        { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
        { id: 'my-custom-gemini', name: 'Custom Gemini' },
      ],
    }
    f.state['opl-suite'].gatewayChannels.gemini = profile
    f.users['opl-suite'].gatewayChannels.gemini = structuredClone(profile)
    await migrateLegacyGatewaySettings(f.ctx)
    expect(f.state['opl-suite'].gatewayChannels.gemini.models).toEqual(profile.models)
  })

  it('keeps custom endpoint prefixes and credentials during a protocol edit', async () => {
    const f = fixture()
    const profile = {
      ...structuredClone(DEFAULT_GATEWAY_CHANNELS.codex),
      baseURL: 'https://tenant.invalid/edge/v1',
      apiKeyEnv: 'CUSTOM_KEY',
      headers: { 'x-tenant': 'tenant' },
    }
    f.state['opl-suite'].gatewayChannels.codex = profile
    f.users['opl-suite'].gatewayChannels.codex = structuredClone(profile)
    await editGatewayModels(f.ctx, {
      group: 'codex',
      revision: 0,
      api: 'anthropic-messages',
      models: profile.models,
    })
    expect(f.state['opl-suite'].gatewayChannels.codex).toMatchObject({
      baseURL: 'https://tenant.invalid/edge/v1',
      apiKeyEnv: 'CUSTOM_KEY',
      headers: { 'x-tenant': 'tenant' },
    })
  })

  it('migrates exact OPL roots and adds only missing adaptive metadata without taking manual catalog ownership', async () => {
    const f = fixture()
    const aws = opusProfile('aws'),
      kiro = opusProfile('kiro')
    f.state['opl-suite'].gatewayChannels.aws = aws
    f.users['opl-suite'].gatewayChannels.aws = structuredClone(aws)
    f.state['opl-suite'].gatewayChannels.kiro = kiro
    f.users['opl-suite'].gatewayChannels.kiro = structuredClone(kiro)
    f.state['opl-suite'].gatewayCatalogHashes.aws = fingerprint(aws.models)
    f.state['opl-suite'].gatewayCatalogHashes.kiro = 'older-auto-import'
    const efforts = structuredClone(aws.models[0]!.reasoningEfforts)
    await migrateLegacyGatewaySettings(f.ctx)
    const nextAws = f.state['opl-suite'].gatewayChannels.aws
    const nextKiro = f.state['opl-suite'].gatewayChannels.kiro
    expect(nextAws.baseURL).toBe('https://gateway.medopl.com')
    expect(nextKiro.baseURL).toBe('https://gateway.medopl.com')
    expect(nextAws.models[0]).toMatchObject({
      compat: { forceAdaptiveThinking: true },
      reasoningEfforts: efforts,
    })
    expect(f.state['opl-suite'].gatewayCatalogHashes.aws).toBe(fingerprint(nextAws.models))
    expect(f.state['opl-suite'].gatewayCatalogHashes.kiro).toBe('older-auto-import')
    expect(f.settings.mutate.mock.calls[0]?.[2]).toBe(0)
    await migrateLegacyGatewaySettings(f.ctx)
    expect(f.settings.mutate).toHaveBeenCalledTimes(1)
  })

  it('preserves custom roots, custom credential references, and an explicit adaptive opt-out', async () => {
    const f = fixture()
    const aws = { ...opusProfile('aws'), baseURL: 'https://tenant.invalid/v1' }
    const kiro = { ...opusProfile('kiro'), apiKeyEnv: 'CUSTOM_KEY' }
    f.state['opl-suite'].gatewayChannels.aws = aws
    f.users['opl-suite'].gatewayChannels.aws = structuredClone(aws)
    f.state['opl-suite'].gatewayChannels.kiro = kiro
    f.users['opl-suite'].gatewayChannels.kiro = structuredClone(kiro)
    await migrateLegacyGatewaySettings(f.ctx)
    expect(f.settings.mutate).not.toHaveBeenCalled()
    const explicit = {
      ...opusProfile('aws'),
      models: [{ ...aws.models[0], compat: { forceAdaptiveThinking: false } }],
    }
    f.state['opl-suite'].gatewayChannels.aws = explicit
    f.users['opl-suite'].gatewayChannels.aws = structuredClone(explicit)
    await migrateLegacyGatewaySettings(f.ctx)
    expect(f.state['opl-suite'].gatewayChannels.aws.models[0]!.compat).toEqual({
      forceAdaptiveThinking: false,
    })
    expect(f.state['opl-suite'].gatewayChannels.aws.models[0]).toMatchObject({
      input: ['text', 'image'],
    })
    expect(f.settings.mutate).toHaveBeenCalledTimes(1)
  })
})

describe('per-group catalog observations', () => {
  it('skips a denied group without losing its configured models and reports a missing key after access is granted', async () => {
    const f = fixture()
    const customModels = [{ id: 'gpt-saved' }]
    f.state['opl-suite'].gatewayChannels.codex = {
      ...structuredClone(DEFAULT_GATEWAY_CHANNELS.codex),
      models: customModels,
    }
    f.users['opl-suite'].gatewayChannels.codex = structuredClone(
      f.state['opl-suite'].gatewayChannels.codex,
    )
    f.state['opl-suite'].gatewayCatalogHashes.codex = fingerprint(customModels)
    const account = f.ctx.get('oplGatewayAccount')!
    const status = await account.status()
    const read = vi.spyOn(account, 'status').mockResolvedValue({
      ...status,
      groups: [{ id: 'codex', name: 'Codex', authorized: false, state: 'unauthorized' }],
    })
    await syncGatewayModels(f.ctx)
    expect((await gatewayModelSettings(f.ctx)).groups.some((g) => g.id === 'codex')).toBe(false)
    expect(f.credentials.resolve).not.toHaveBeenCalledWith('OPL_GATEWAY_CODEX_API_KEY')
    expect(f.state['opl-suite'].gatewayChannels.codex.models).toEqual(customModels)
    read.mockResolvedValue({
      ...status,
      groups: [{ id: 'codex', name: 'Codex', authorized: true, state: 'unconfigured' }],
    })
    f.keys.clear()
    await syncGatewayModels(f.ctx)
    expect((await gatewayModelSettings(f.ctx)).groups.find((g) => g.id === 'codex')).toMatchObject({
      catalog: { state: 'error', diagnostic: { code: 'missing_credentials' } },
    })
  })

  it('does not equate credential readiness with successful discovery', async () => {
    const f = fixture()
    expect((await gatewayModelSettings(f.ctx)).groups.find((g) => g.id === 'codex')).toMatchObject({
      ready: true,
      catalog: { state: 'unverified' },
    })
    await discoverGatewayModels(f.ctx, { group: 'codex' })
    expect(
      (await gatewayModelSettings(f.ctx)).groups.find((g) => g.id === 'codex')?.catalog,
    ).toEqual({ state: 'ready', count: 1 })
    f.discover.mockResolvedValue([])
    await discoverGatewayModels(f.ctx, { group: 'codex' })
    expect(
      (await gatewayModelSettings(f.ctx)).groups.find((g) => g.id === 'codex')?.catalog,
    ).toEqual({ state: 'empty', count: 0 })
  })

  it('uses the effective endpoint prefix and credential reference for Anthropic-group OpenAI listing', async () => {
    const f = fixture()
    f.state['opl-suite'].gatewayChannels.aws = {
      ...opusProfile('aws'),
      baseURL: 'https://tenant.invalid/edge',
      apiKeyEnv: 'CUSTOM_KEY',
    }
    f.keys.set('CUSTOM_KEY', 'custom-fixture')
    await discoverGatewayModels(f.ctx, { group: 'aws' })
    expect(f.discover).toHaveBeenCalledExactlyOnceWith(
      'llm-pi-ai',
      {
        provider: 'opl-gateway-aws',
        baseURL: 'https://tenant.invalid/edge/v1',
        api: 'openai-completions',
        apiKey: 'custom-fixture',
      },
      expect.any(AbortSignal),
    )
    expect(f.credentials.resolve).toHaveBeenCalledExactlyOnceWith('CUSTOM_KEY')
    f.keys.delete('CUSTOM_KEY')
    await expect(discoverGatewayModels(f.ctx, { group: 'aws' })).rejects.toMatchObject({
      diagnostic: { code: 'missing_credentials' },
    })
    expect(f.discover).toHaveBeenCalledTimes(1)
  })

  it('keeps the OpenAI endpoint exact and rejects unusable endpoint configuration before resolving a key', async () => {
    const f = fixture()
    f.state['opl-suite'].gatewayChannels.codex = {
      ...structuredClone(DEFAULT_GATEWAY_CHANNELS.codex),
      baseURL: 'https://tenant.invalid/prefix/v7',
    }
    await discoverGatewayModels(f.ctx, { group: 'codex' })
    expect(f.discover.mock.calls[0]?.[1]).toMatchObject({
      baseURL: 'https://tenant.invalid/prefix/v7',
    })
    f.state['opl-suite'].gatewayChannels.codex.baseURL =
      'https://tenant.invalid/v1?access_token=fixture-private'
    f.credentials.resolve.mockClear()
    await expect(discoverGatewayModels(f.ctx, { group: 'codex' })).rejects.toMatchObject({
      diagnostic: { code: 'configuration' },
    })
    expect(f.credentials.resolve).not.toHaveBeenCalled()
    expect(f.discover).toHaveBeenCalledTimes(1)
  })

  it('retains lossless manually configured model metadata in candidate results', async () => {
    const f = fixture()
    const model = {
      id: 'gpt-new',
      input: ['text'],
      compat: { supportsDeveloperRole: false },
      metadata: { nested: [true, null, { limit: 123 }] },
    }
    f.state['opl-suite'].gatewayChannels.codex = {
      ...structuredClone(DEFAULT_GATEWAY_CHANNELS.codex),
      models: [model],
    }
    expect(await discoverGatewayModels(f.ctx, { group: 'codex' })).toEqual([model])
    await editGatewayModels(f.ctx, {
      group: 'codex',
      revision: 0,
      api: 'openai-responses',
      models: [model],
    })
    expect(f.users['opl-suite'].gatewayChannels.codex.models).toEqual([model])
  })

  it('preserves failed catalogs and their ownership hashes while another group synchronizes', async () => {
    const f = fixture()
    const aws = opusProfile('aws')
    aws.baseURL = 'https://gateway.medopl.com'
    Object.assign(aws.models[0]!, { compat: { forceAdaptiveThinking: true } })
    Object.assign(aws.models[0]!, { input: ['text', 'image'] })
    f.state['opl-suite'].gatewayChannels.aws = aws
    f.users['opl-suite'].gatewayChannels.aws = structuredClone(aws)
    f.state['opl-suite'].gatewayCatalogHashes.aws = fingerprint(aws.models)
    const previousHash = f.state['opl-suite'].gatewayCatalogHashes.aws
    f.keys.set('OPL_GATEWAY_AWS_API_KEY', 'aws-fixture')
    f.discover.mockImplementation(async (_ns, request: any) => {
      if (request.apiKey === 'aws-fixture')
        throw new LlmError(
          'https://fixture.invalid/secret?key=fixture-private answered 403; check the API key',
          'DISCOVERY_FAILED',
        )
      return [{ id: 'gpt-new' }]
    })
    await syncGatewayModels(f.ctx)
    expect(f.state['opl-suite'].gatewayChannels.codex.models).toEqual([{ id: 'gpt-new' }])
    expect(f.state['opl-suite'].gatewayChannels.aws).toEqual(aws)
    expect(f.state['opl-suite'].gatewayCatalogHashes.aws).toBe(previousHash)
    expect(
      (await gatewayModelSettings(f.ctx)).groups.find((g) => g.id === 'aws')?.catalog,
    ).toMatchObject({ state: 'error', diagnostic: { code: 'authentication', status: 403 } })
    const visible = JSON.stringify([
      await gatewayModelSettings(f.ctx),
      (f.ctx.logger.warn as any).mock.calls,
    ])
    expect(visible).not.toContain('fixture-private')
    expect(visible).not.toContain('fixture.invalid/secret')
    expect((f.ctx.logger.warn as any).mock.calls.length).toBeLessThanOrEqual(6)
  })

  it('records missing discovery service failures instead of silently skipping all groups', async () => {
    const f = fixture()
    f.discover.mockRejectedValue(new LlmError('service details not for UI', 'NO_DISCOVERY'))
    await syncGatewayModels(f.ctx)
    expect(
      (await gatewayModelSettings(f.ctx)).groups.find((g) => g.id === 'codex')?.catalog,
    ).toMatchObject({ state: 'error', diagnostic: { code: 'service_unavailable' } })
    expect(f.state['opl-suite'].gatewayChannels.codex).toBeUndefined()
    expect(f.state['opl-suite'].gatewayCatalogHashes).toEqual({})
  })

  it('keeps exact default inputs across discovery and repeated automatic imports', async () => {
    const f = fixture()
    f.state['opl-suite'].gatewayChannels.codex = {
      ...structuredClone(DEFAULT_GATEWAY_CHANNELS.codex),
      models: [{ id: 'gpt-5' }],
    }
    f.discover.mockResolvedValue([{ id: 'gpt-6.2-astra' }, { id: 'gpt-6.1-terra' }])
    const expected = [
      { id: 'gpt-6.2-astra', input: ['text', 'image'] },
      { id: 'gpt-6.1-terra', input: ['text', 'image'] },
    ]
    expect(await discoverGatewayModels(f.ctx, { group: 'codex' })).toEqual(expected)
    await syncGatewayModels(f.ctx)
    expect(f.state['opl-suite'].gatewayChannels.codex.models).toEqual(expected)
    await syncGatewayModels(f.ctx)
    expect(f.state['opl-suite'].gatewayChannels.codex.models).toEqual(expected)
    expect(f.state['opl-suite'].gatewayCatalogHashes.codex).toBe(fingerprint(expected))
  })

  it('does not add catalog image inputs during custom-endpoint discovery or to an explicit text-only choice', async () => {
    const f = fixture()
    f.state['opl-suite'].gatewayChannels.codex = {
      ...structuredClone(DEFAULT_GATEWAY_CHANNELS.codex),
      baseURL: 'https://tenant.invalid/v1',
      models: [{ id: 'gpt-5' }],
    }
    f.discover.mockResolvedValue([{ id: 'gpt-6.2-astra' }])
    expect(await discoverGatewayModels(f.ctx, { group: 'codex' })).toEqual([
      { id: 'gpt-6.2-astra' },
    ])
    const manual = {
      ...structuredClone(DEFAULT_GATEWAY_CHANNELS.codex),
      baseURL: 'https://gateway.medopl.com/v1',
      models: [{ id: 'gpt-6.2-astra', input: ['text'], custom: { policy: 'manual' } }],
    }
    f.state['opl-suite'].gatewayChannels.codex = manual
    f.users['opl-suite'].gatewayChannels.codex = structuredClone(manual)
    expect(await discoverGatewayModels(f.ctx, { group: 'codex' })).toEqual(manual.models)
    await migrateLegacyGatewaySettings(f.ctx)
    expect(f.settings.mutate).not.toHaveBeenCalled()
  })

  it('retries transient network failures in model discovery and clears stale error status after manual save or skipped sync', async () => {
    const f = fixture()
    f.state['opl-suite'].gatewayChannels.codex = {
      ...structuredClone(DEFAULT_GATEWAY_CHANNELS.codex),
      models: [{ id: 'gpt-5' }],
    }
    f.discover
      .mockRejectedValueOnce(
        new LlmError('socket reset', 'DISCOVERY_FAILED', { cause: new TypeError('fetch failed') }),
      )
      .mockResolvedValueOnce([{ id: 'gpt-6.2-astra' }])
    expect(await discoverGatewayModels(f.ctx, { group: 'codex' })).toEqual([
      { id: 'gpt-6.2-astra', input: ['text', 'image'] },
    ])
    expect(f.discover).toHaveBeenCalledTimes(2)

    f.discover.mockRejectedValue(
      new LlmError('still offline', 'DISCOVERY_FAILED', { cause: new TypeError('fetch failed') }),
    )
    await expect(discoverGatewayModels(f.ctx, { group: 'codex' })).rejects.toMatchObject({
      diagnostic: { code: 'network' },
    })
    expect(
      (await gatewayModelSettings(f.ctx)).groups.find((g) => g.id === 'codex')?.catalog?.state,
    ).toBe('error')

    await editGatewayModels(f.ctx, {
      group: 'codex',
      revision: f.revisions['opl-suite']!,
      api: 'openai-responses',
      models: [{ id: 'gpt-6.2-astra' }],
    })
    expect(
      (await gatewayModelSettings(f.ctx)).groups.find((g) => g.id === 'codex')?.catalog,
    ).toEqual({
      state: 'unverified',
    })

    await expect(discoverGatewayModels(f.ctx, { group: 'codex' })).rejects.toMatchObject({
      diagnostic: { code: 'network' },
    })
    await syncGatewayModels(f.ctx)
    expect(
      (await gatewayModelSettings(f.ctx)).groups.find((g) => g.id === 'codex')?.catalog,
    ).toEqual({
      state: 'unverified',
    })
  })

  it('upgrades uncustomized legacy GPT-6/6.1 Codex defaults once and preserves user choices afterwards', async () => {
    const f = fixture({ officialRedaction: true })
    const legacyCodex = {
      displayName: 'OPL Gateway · Codex',
      api: 'openai-responses',
      baseURL: 'https://gateway.medopl.com/v1',
      apiKeyEnv: 'OPL_GATEWAY_CODEX_API_KEY',
      models: [
        {
          id: 'deepseek-flash',
          name: 'DeepSeek-V4.1-Flash',
          compat: { chatTemplateKwargs: {}, chatTemplateArgs: {} },
        },
        {
          id: 'gpt-6-astra',
          name: 'GPT-6 Astra',
          input: ['text', 'image'],
          compat: { chatTemplateKwargs: {}, chatTemplateArgs: {} },
        },
        {
          id: 'gpt-6-luna',
          name: 'GPT-6 Luna',
          input: ['text', 'image'],
        },
        {
          id: 'gpt-6.1-sol',
          name: 'GPT-6.1 Sol',
          input: ['text', 'image'],
        },
        {
          id: 'gpt-6.1-terra',
          name: 'GPT-6.1 Terra',
          input: ['text', 'image'],
        },
      ],
    }
    f.users['opl-suite'].gatewayChannels = { codex: structuredClone(legacyCodex) }
    f.state['opl-suite'].gatewayChannels = { codex: structuredClone(legacyCodex) }

    await migrateLegacyGatewaySettings(f.ctx)

    expect(f.state['opl-suite'].gatewayCodexModelMigration).toBe('gpt-6.2')
    const migratedIds = f.state['opl-suite'].gatewayChannels.codex.models.map(
      (model: { id: string }) => model.id,
    )
    expect(migratedIds).toEqual([
      'deepseek-flash',
      'gpt-6.2-astra',
      'gpt-6-luna',
      'gpt-6.2-sol',
      'gpt-6.1-terra',
    ])
    const mutateCount = f.settings.mutate.mock.calls.length

    await editGatewayModels(f.ctx, {
      group: 'codex',
      api: 'openai-responses',
      revision: f.revisions['opl-suite']!,
      models: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', input: ['text', 'image'] }],
    })
    const callsAfterManualEdit = f.settings.mutate.mock.calls.length
    expect(callsAfterManualEdit).toBeGreaterThan(mutateCount)

    await migrateLegacyGatewaySettings(f.ctx)
    expect(f.settings.mutate).toHaveBeenCalledTimes(callsAfterManualEdit)
    expect(f.state['opl-suite'].gatewayChannels.codex.models).toEqual([
      { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', input: ['text', 'image'] },
    ])
  })
})
