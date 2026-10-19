/** Native tool-free adapter for BambooNode's StartLux decision endpoint. */
import { attributionHeaders, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

export const BAMBOO_STARTLUX_MODEL = {
  provider: 'bamboo-startlux',
  model: 'startlux-decision-27b-autothink',
} as const
export const BAMBOO_STARTLUX_ENDPOINT = 'https://api.bamboonode.dev/v1/decisions'

const DECISION_QUESTION = 'review-decision'
const CHOICES = {
  low_allow: 'Allow low-risk local work.',
  medium_allow: 'Allow explicitly authorized medium-risk work.',
  medium_deny: 'Deny medium-risk work without exact current authorization.',
  high_deny: 'Deny high-risk or sensitive external data actions.',
  uncertain: 'The facts are incomplete or contradictory; fail closed.',
} as const

function textOf(options: GenerateOptions): string {
  const blocks: string[] = []
  if (options.system) blocks.push(options.system)
  for (const message of options.messages) {
    for (const block of message.content) {
      if (block.type === 'text') blocks.push(block.text)
    }
  }
  return blocks.join('\n\n')
}

function answerText(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new LlmError('Bamboo 审查返回了不可读的结果', 'INVALID_PROVIDER_RESPONSE')
  const answers = (value as { answers?: unknown }).answers
  if (answers === null || typeof answers !== 'object' || Array.isArray(answers))
    throw new LlmError('Bamboo 审查没有返回选择结果', 'INVALID_PROVIDER_RESPONSE')
  const item = (answers as Record<string, unknown>)[DECISION_QUESTION]
  if (item === null || typeof item !== 'object' || Array.isArray(item))
    throw new LlmError('Bamboo 审查选择结果缺失', 'INVALID_PROVIDER_RESPONSE')
  const choice = (item as { choice?: unknown }).choice
  if (typeof choice !== 'string' || !(choice in CHOICES))
    throw new LlmError('Bamboo 审查返回了未知选择', 'INVALID_PROVIDER_RESPONSE')
  return JSON.stringify(
    choice === 'low_allow'
      ? { risk: 'low', decision: 'allow' }
      : choice === 'medium_allow'
        ? { risk: 'medium', decision: 'allow' }
        : choice === 'medium_deny'
          ? { risk: 'medium', decision: 'deny' }
          : { risk: 'high', decision: 'deny' },
  )
}

/** One synchronous StartLux request projected into DSH's stream vocabulary. */
export class BambooStartLuxAdapter extends LlmAdapter {
  constructor(
    private readonly resolveKey: () => Promise<string | undefined>,
    private readonly endpoint: string = BAMBOO_STARTLUX_ENDPOINT,
  ) {
    super()
  }
  override providerInfo(provider: string) {
    return { id: provider, name: 'BambooNode · StartLux' }
  }
  override async listModels(provider: string) {
    return [{ provider, id: BAMBOO_STARTLUX_MODEL.model, name: 'StartLux Decision 27B AutoThink' }]
  }
  override async resolveModel(provider: string, model: string) {
    if (provider !== BAMBOO_STARTLUX_MODEL.provider || model !== BAMBOO_STARTLUX_MODEL.model)
      throw new LlmError('Bamboo StartLux 不支持该模型', 'UNKNOWN_MODEL')
    return {
      provider,
      id: model,
      name: 'StartLux Decision 27B AutoThink',
      context: { contextWindow: 262144 },
      reasoning: { efforts: [] },
    }
  }
  override async prepareCall(provider: string, model: string, signal?: AbortSignal) {
    const resolved = await this.resolveModel(provider, model)
    const key = await this.resolveKey()
    if (!key) throw new LlmError('请先在模型供应商设置中保存 Bamboo API Key', 'CREDENTIAL_MISSING')
    return {
      model: resolved,
      stream: (options: GenerateOptions) => this.streamWithKey(key, options, signal),
    }
  }
  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamWithKey(undefined, options)
  }
  private async *streamWithKey(
    preparedKey: string | undefined,
    options: GenerateOptions,
    preparedSignal?: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    const signal = options.signal ?? preparedSignal
    signal?.throwIfAborted()
    if (options.tools?.length || options.toolHistory || options.sessionId)
      throw new LlmError('Bamboo StartLux 审查路线不接受工具或会话绑定', 'UNSUPPORTED_REQUEST')
    const key = preparedKey ?? (await this.resolveKey())
    if (!key) throw new LlmError('请先在模型供应商设置中保存 Bamboo API Key', 'CREDENTIAL_MISSING')
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        ...attributionHeaders(),
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: BAMBOO_STARTLUX_MODEL.model,
        state: textOf(options),
        questions: {
          [DECISION_QUESTION]: {
            type: 'choice',
            instructions: 'Choose exactly one outcome for the pending tool action.',
            criteria: CHOICES,
          },
        },
        think_mode: 'auto',
        gate: 0.9,
        think_budget: Math.min(Math.max(options.maxTokens ?? 4096, 64), 4096),
        none_check: true,
        allow_none: true,
        return_details: false,
      }),
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) throw new LlmError('Bamboo 审查请求失败', `HTTP_${response.status}`)
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new LlmError('Bamboo 审查返回了无效 JSON', 'INVALID_PROVIDER_RESPONSE')
    }
    const text = answerText(body)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
