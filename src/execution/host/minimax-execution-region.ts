import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { oplProfilePath } from '../../shared/host/profile-paths.ts'
import {
  minimaxAccountDataDir,
  readMiniMaxAccountLoginState,
  type MiniMaxAccountRegion,
} from './minimax-account-state.ts'

async function readOptional(path: string) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export async function minimaxExecutionRegion(
  home: string,
  prefix: readonly string[] = [],
): Promise<MiniMaxAccountRegion> {
  const stored = await readOptional(oplProfilePath(home, 'minimax-region'))
  if (stored !== undefined) {
    const region = stored.trim()
    if (region === 'cn' || region === 'global') return region
    throw Error('MiniMax 使用地区配置无效')
  }
  const fromCli = (value: unknown) =>
    value === 'cn' ? 'cn' : value === 'en' ? 'global' : undefined
  const envRegion = fromCli(process.env.MAVIS_REGION)
  if (envRegion) return envRegion
  const preferences = await readOptional(
    join(minimaxAccountDataDir(process.env, prefix), 'preferences', 'mcode-region.json'),
  )
  if (preferences) {
    const region = fromCli(JSON.parse(preferences)?.regions?.prod)
    if (region) return region
  }
  const [global, cn] = await Promise.all(
    (['global', 'cn'] as const).map((region) => readMiniMaxAccountLoginState(region, { prefix })),
  )
  return global.loginState !== 'signed-in' && cn.loginState === 'signed-in' ? 'cn' : 'global'
}

export async function saveMinimaxExecutionRegion(home: string, region: MiniMaxAccountRegion) {
  if (region !== 'cn' && region !== 'global') throw Error('MiniMax 使用地区无效')
  await writeFileAtomic(oplProfilePath(home, 'minimax-region'), region + '\n', {
    mode: 0o600,
    dirMode: 0o700,
  })
}
