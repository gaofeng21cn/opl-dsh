/** Optional Gateway password storage; secrets stay in the Windows credential store and Host. */
import {
  gatewayLoginKeyring,
  type SuiteKeyringCredential,
} from '../../credentials/host/windows-keyring.ts'
import type { GatewayRememberedLogin } from '../contracts/account.ts'

export class GatewayPasswordStore {
  constructor(private readonly keyring: SuiteKeyringCredential = gatewayLoginKeyring) {}

  private async read(): Promise<{ email: string; password: string } | undefined> {
    const value = await this.keyring.read()
    if (value === undefined) return undefined
    try {
      const parsed: unknown = JSON.parse(value)
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'email' in parsed &&
        'password' in parsed &&
        typeof parsed.email === 'string' &&
        parsed.email.trim() &&
        typeof parsed.password === 'string' &&
        parsed.password
      )
        return { email: parsed.email, password: parsed.password }
    } catch {
      /* Invalid saved data is reported without including its contents. */
    }
    throw Error('保存的登录信息无效，请清除后重新保存')
  }

  /** Return availability and account identity without returning the password. */
  async describe(): Promise<GatewayRememberedLogin> {
    const info = await this.keyring.describe()
    if (!info.available) return { supported: false }
    const login = info.configured ? await this.read() : undefined
    return { supported: true, ...(login ? { email: login.email } : {}) }
  }

  /** Read only the saved password for the account explicitly selected by the user. */
  async password(email: string): Promise<string> {
    const login = await this.read()
    if (!login || login.email !== email.trim()) throw Error('该账号没有保存密码，请重新输入')
    return login.password
  }

  /** Store a successfully authenticated account in the OS credential manager. */
  async save(email: string, password: string): Promise<void> {
    await this.keyring.set(JSON.stringify({ email: email.trim(), password }))
  }

  /** Clear this feature’s credential only; unsupported platforms store nothing. */
  async clear(): Promise<void> {
    const info = await this.keyring.describe()
    if (!info.supported) return
    await this.keyring.remove()
  }
}
