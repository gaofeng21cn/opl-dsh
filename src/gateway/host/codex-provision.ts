import { createHash } from 'node:crypto'
import { hostname, homedir } from 'node:os'
import type { GatewayControlClient, GatewayManagedKey } from './gateway-control.ts'

export class CodexProvisionError extends Error {}

/** Isolate this OS user and Codex target from the DSH account sign-out lifecycle. */
export function codexGatewayKeyName(target: string, distro: string): string {
  const identity = createHash('sha256')
    .update(JSON.stringify([hostname(), homedir(), target, distro]))
    .digest('hex')
    .slice(0, 16)
  return `OPL Codex · ${hostname().slice(0, 32)} · ${target === 'wsl' ? 'WSL ' + distro.slice(0, 24) : target === 'mac' ? 'macOS' : 'Windows'} · ${identity}`
}

type KeyControl = Pick<GatewayControlClient, 'keys' | 'createKey' | 'setKeyStatus'>

/** Issue after local preflight. On failure only disable a key created by this operation. */
export async function withCodexGatewayKey(
  control: KeyControl,
  token: string,
  groupId: string,
  name: string,
  configure: (issue: () => Promise<string>) => Promise<void>,
): Promise<void> {
  if (!/^[1-9]\d*$/.test(groupId) || !Number.isSafeInteger(Number(groupId)))
    throw new CodexProvisionError('网关未返回有效的 Codex 分组。')
  let created: GatewayManagedKey | undefined
  let issued: Promise<string> | undefined
  async function issue(): Promise<string> {
    const matches = (await control.keys(token, name)).filter(
      (key) => key.name === name && key.status === 'active',
    )
    if (matches.length > 1 || (matches[0] && matches[0].groupId !== groupId)) {
      throw new CodexProvisionError(
        '网关中已有同名密钥，但无法确认唯一分组。请检查网关账户中的专用密钥。',
      )
    }
    const key = matches[0] ?? (created = await control.createKey(token, name, groupId))
    if (
      key.groupId !== groupId ||
      key.name !== name ||
      key.status !== 'active' ||
      !/^[A-Za-z0-9_-]{12,}$/.test(key.key)
    )
      throw new CodexProvisionError('网关未返回可用于此分组的完整专用密钥。')
    return key.key
  }
  try {
    await configure(() => (issued ??= issue()))
  } catch (error) {
    if (created) {
      try {
        await control.setKeyStatus(token, created, 'disabled')
      } catch {
        throw new CodexProvisionError(
          '配置失败，且未能确认已停用本次新建的专用密钥。请到网关账户检查。',
        )
      }
    }
    throw error
  }
}
