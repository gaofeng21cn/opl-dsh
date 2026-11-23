/** Keep DSH's active Computer Use calls and replacement of the shared runtime mutually exclusive. */
interface KimiCuLease {
  closeClients: Set<() => Promise<void>>
  active: number
  replacing: boolean
}

// The update and Computer Use plugins may be loaded from separate host bundles.
const symbol = Symbol.for('opl.dsh.kimi-cu.update-lease.v1')
const host = globalThis as typeof globalThis & { [symbol]?: KimiCuLease }
const lease = (host[symbol] ??= {
  closeClients: new Set(),
  active: 0,
  replacing: false,
} as KimiCuLease)

export function registerKimiCuClients(close: () => Promise<void>): () => void {
  lease.closeClients.add(close)
  return () => {
    lease.closeClients.delete(close)
  }
}

export async function withKimiCuCall<T>(call: () => Promise<T>): Promise<T> {
  if (lease.replacing) throw Error('KimiCU 正在更新，请稍后再试。')
  lease.active++
  try {
    return await call()
  } finally {
    lease.active--
  }
}

export async function withKimiCuUpdate<T>(apply: () => Promise<T>): Promise<T> {
  if (lease.active || lease.replacing) throw Error('kimi-cu-busy')
  lease.replacing = true
  try {
    await Promise.all(Array.from(lease.closeClients, (close) => close()))
    return await apply()
  } finally {
    lease.replacing = false
  }
}
