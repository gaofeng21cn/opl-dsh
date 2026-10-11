/** MiniMax's advertised Full access mode matches an explicitly authorized full-access task. */
import { HarnessConfigurationError } from '../acp.ts'
import type { HarnessAdapter } from './types.ts'

function permission(options: unknown): { currentValue: unknown; values: unknown[] } | undefined {
  if (!Array.isArray(options)) return undefined
  const entry = options.find((item) => item?.id === 'permissionMode' && item.type === 'select')
  if (!entry || !Array.isArray(entry.options)) return undefined
  return {
    currentValue: entry.currentValue,
    values: entry.options.map((item: { value?: unknown }) => item?.value),
  }
}

/** Configure and verify the CLI policy on new/load and before each prompt; never answer pending requests. */
export function withMinimaxPermissions(adapter: HarnessAdapter): HarnessAdapter {
  return {
    ...adapter,
    async configureSession(acp, record, snapshot) {
      if (record.sandbox !== 'full-access')
        throw new HarnessConfigurationError('MiniMax 仅支持明确授权的完整访问，未发送任务。')
      const configured = await adapter.configureSession?.(acp, record, snapshot)
      let options = configured?.configOptions ?? snapshot.configOptions
      const mode = permission(options)
      if (!mode?.values.includes('bypassPermissions'))
        throw new HarnessConfigurationError('MiniMax 未广告 Full access 权限模式，未发送任务。')
      if (mode.currentValue !== 'bypassPermissions') {
        try {
          const result = (await acp.request('session/set_config_option', {
            sessionId: record.acpSessionId,
            configId: 'permissionMode',
            value: 'bypassPermissions',
          })) as { configOptions?: unknown }
          options = result?.configOptions
        } catch {
          throw new HarnessConfigurationError('MiniMax 拒绝设置 Full access 权限模式，未发送任务。')
        }
      }
      if (permission(options)?.currentValue !== 'bypassPermissions')
        throw new HarnessConfigurationError('MiniMax 未确认 Full access 权限模式，未发送任务。')
      adapter.verifySession?.(record, { ...snapshot, configOptions: options })
      return { configOptions: options }
    },
    verifySession(record, snapshot) {
      if (
        record.sandbox !== 'full-access' ||
        permission(snapshot.configOptions)?.currentValue !== 'bypassPermissions'
      )
        throw new HarnessConfigurationError('MiniMax 权限与已授权完整访问不一致，未发送任务。')
      adapter.verifySession?.(record, snapshot)
    },
  }
}
