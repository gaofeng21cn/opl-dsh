import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { HarnessConfigurationError } from '../acp.ts'
import type { HarnessCapabilities } from '../../contracts/capabilities.ts'
import type { HarnessDefinition, ModelRef } from '../../contracts/catalog.ts'
import { executablePath, commandLaunch } from '../harness-registry.ts'
import { systemEnvironment } from './environment.ts'
import type { AcpSessionConfigureResult, AcpSessionSnapshot, HarnessAdapter } from './types.ts'

/** Declared capabilities shared by user-registered standard ACP CLI engines. */
export const CUSTOM_ACP_CAPABILITIES: HarnessCapabilities = {
  transport: 'acp',
  authentication: 'official-account',
  protocols: [],
  customEndpoint: false,
  permissions: ['full-access'],
  sessionLoad: true,
  cancel: true,
  reasoning: 'cli-advertised',
  autoReview: 'unsupported',
}

/** Resolve the wire model identifier expected from a custom ACP CLI. */
export function customAcpWireModel(ref: ModelRef): string {
  return ref.provider === 'opl-gateway' && ref.model.includes('::')
    ? ref.model.slice(ref.model.lastIndexOf('::') + 2)
    : ref.model
}

function modelCandidates(ref: ModelRef): string[] {
  return [...new Set([customAcpWireModel(ref), ref.model])]
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function findModelConfigOption(configOptions: unknown): Record<string, any> | undefined {
  if (!Array.isArray(configOptions)) return undefined
  return configOptions.find(
    (item) =>
      isRecord(item) &&
      item.type === 'select' &&
      (item.id === 'model' || item.category === 'model'),
  )
}

function flattenOptionValues(options: unknown): string[] {
  if (!Array.isArray(options)) return []
  const values: string[] = []
  for (const item of options) {
    if (isRecord(item) && Array.isArray(item.options)) {
      values.push(...flattenOptionValues(item.options))
    } else if (isRecord(item) && typeof item.value === 'string') {
      values.push(item.value)
    } else if (typeof item === 'string') {
      values.push(item)
    }
  }
  return values
}

function findMatchingAvailableModel(
  availableModels: unknown,
  candidates: readonly string[],
): string | undefined {
  if (!Array.isArray(availableModels)) return undefined
  for (const item of availableModels) {
    const id =
      typeof item === 'string'
        ? item
        : isRecord(item) && typeof item.modelId === 'string'
          ? item.modelId
          : isRecord(item) && typeof item.id === 'string'
            ? item.id
            : undefined
    if (id && candidates.includes(id)) return id
  }
  return undefined
}

function verifyCustomAcpSessionState(
  harness: HarnessDefinition,
  modelRef: ModelRef,
  snapshot: AcpSessionSnapshot,
): void {
  const candidates = modelCandidates(modelRef)
  const expected = customAcpWireModel(modelRef)
  const modelsInfo = isRecord(snapshot.session?.models) ? snapshot.session.models : undefined
  const currentModelId =
    typeof modelsInfo?.currentModelId === 'string' ? modelsInfo.currentModelId : undefined
  const modelOption = findModelConfigOption(snapshot.configOptions)
  if (currentModelId !== undefined && !candidates.includes(currentModelId)) {
    throw new HarnessConfigurationError(
      `自定义 ACP 引擎实际运行模型（${currentModelId}）与所选模型（${expected}）不符，已停止。`,
    )
  }
  if (
    modelOption?.currentValue !== undefined &&
    !candidates.includes(String(modelOption.currentValue))
  ) {
    throw new HarnessConfigurationError(
      `自定义 ACP 引擎模型配置（${String(modelOption.currentValue)}）与所选模型（${expected}）不符，已停止。`,
    )
  }
  const hasExplicitAdvertisement =
    currentModelId !== undefined || modelOption?.currentValue !== undefined
  if (!hasExplicitAdvertisement) {
    const fixed = harness.fixedModel?.trim()
    if (!fixed || !candidates.includes(fixed)) {
      throw new HarnessConfigurationError(
        `自定义 ACP 引擎未返回可用模型且未声明固定模型（需匹配 ${expected}），无法确认实际执行模型。`,
      )
    }
  }
}

/** Build a generic runtime adapter for an explicitly registered custom ACP engine. */
export function createCustomAcpAdapter(harness: HarnessDefinition): HarnessAdapter {
  return {
    id: harness.id,
    transport: 'acp',
    capabilities: CUSTOM_ACP_CAPABILITIES,
    acpModelId: customAcpWireModel,
    matches: () => true,
    async available(_ctx, options) {
      const target = options.command || harness.command || ''
      const resolved = target ? await executablePath(target) : undefined
      return resolved
        ? { available: true }
        : {
            available: false,
            reason: `未找到自定义 ACP 程序（${target || harness.name}），请在执行引擎设置中检查路径`,
          }
    },
    async prepare(_ctx, record, options) {
      if (record.sandbox !== 'full-access')
        throw new HarnessConfigurationError(
          '自定义标准 ACP 引擎由外部 CLI 自主管理工具权限，仅支持显式授权的 full-access 权限。',
        )
      const target = options.command || harness.command || ''
      const resolved = target ? await executablePath(target) : undefined
      if (!resolved)
        throw new HarnessConfigurationError(
          `未找到自定义 ACP 程序（${target || harness.name}），无法启动此组合`,
        )
      const home = join(options.home, 'harnesses', 'custom', harness.id)
      await mkdir(home, { recursive: true, mode: 0o700 })
      const launch = commandLaunch(resolved, [...(options.prefix ?? harness.prefix ?? [])])
      return {
        home,
        command: launch.command,
        args: launch.args,
        env: systemEnvironment(),
        ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      }
    },
    async configureSession(acp, record, snapshot): Promise<AcpSessionConfigureResult> {
      const candidates = modelCandidates(record.modelRef)
      const expected = customAcpWireModel(record.modelRef)
      const sessionId =
        typeof snapshot.session?.sessionId === 'string' && snapshot.session.sessionId.trim()
          ? snapshot.session.sessionId.trim()
          : record.acpSessionId
      const modelsInfo = isRecord(snapshot.session?.models) ? snapshot.session.models : undefined
      const currentModelId =
        typeof modelsInfo?.currentModelId === 'string' ? modelsInfo.currentModelId : undefined
      if (currentModelId && candidates.includes(currentModelId)) {
        return { modelId: expected, configOptions: snapshot.configOptions }
      }
      const matchedAvailable = findMatchingAvailableModel(modelsInfo?.availableModels, candidates)
      if (matchedAvailable) {
        if (!sessionId)
          throw new HarnessConfigurationError('自定义 ACP 引擎未返回会话 ID，无法切换模型。')
        const updated = await acp.request('session/set_model', {
          sessionId,
          modelId: matchedAvailable,
        })
        if (isRecord(updated)) {
          const readback =
            typeof updated.currentModelId === 'string'
              ? updated.currentModelId
              : isRecord(updated.models) && typeof updated.models.currentModelId === 'string'
                ? updated.models.currentModelId
                : undefined
          if (readback !== undefined && !candidates.includes(readback)) {
            throw new HarnessConfigurationError(
              `自定义 ACP 引擎切换模型失败：实际返回 ${readback}，而非 ${expected}。`,
            )
          }
        }
        return { modelId: expected, configOptions: snapshot.configOptions }
      }
      const modelOption = findModelConfigOption(snapshot.configOptions)
      if (modelOption) {
        if (
          modelOption.currentValue !== undefined &&
          candidates.includes(String(modelOption.currentValue))
        ) {
          return { modelId: expected, configOptions: snapshot.configOptions }
        }
        const matchedOption = flattenOptionValues(modelOption.options).find((val) =>
          candidates.includes(val),
        )
        if (matchedOption && typeof modelOption.id === 'string') {
          if (!sessionId)
            throw new HarnessConfigurationError('自定义 ACP 引擎未返回会话 ID，无法设置模型选项。')
          const result = await acp.request('session/set_config_option', {
            sessionId,
            configId: modelOption.id,
            value: matchedOption,
          })
          const nextOptions =
            isRecord(result) && 'configOptions' in result
              ? result.configOptions
              : snapshot.configOptions
          const verifiedOption = findModelConfigOption(nextOptions)
          if (
            verifiedOption?.currentValue !== undefined &&
            !candidates.includes(String(verifiedOption.currentValue))
          ) {
            throw new HarnessConfigurationError(
              `自定义 ACP 引擎未能锁定所选模型（${expected}），实际返回 ${String(verifiedOption.currentValue)}。`,
            )
          }
          return { modelId: expected, configOptions: nextOptions }
        }
        throw new HarnessConfigurationError(
          `自定义 ACP 引擎支持的模型列表不包含所选模型（${expected}），未发送任务。`,
        )
      }
      if (modelsInfo) {
        throw new HarnessConfigurationError(
          `自定义 ACP 引擎声明的模型不包含所选模型（${expected}），未发送任务。`,
        )
      }
      const fixed = harness.fixedModel?.trim()
      if (fixed && candidates.includes(fixed)) {
        return { modelId: expected, configOptions: snapshot.configOptions }
      }
      throw new HarnessConfigurationError(
        `自定义 ACP 引擎未报告可用模型且未声明固定模型（${expected}）。请在执行引擎设置中填写固定模型，或改用支持 ACP 模型协商的 CLI。`,
      )
    },
    verifySession(record, snapshot) {
      verifyCustomAcpSessionState(harness, record.modelRef, snapshot)
    },
  }
}
