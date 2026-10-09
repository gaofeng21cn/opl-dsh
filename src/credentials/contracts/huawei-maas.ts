import type { KeyringCredentialInfo, KeyringFailureCode } from './windows-keyring.ts'

/** Huawei connection metadata and credential presence; never the API Key. */
export interface HuaweiMaaSStatus {
  readonly baseUrl: string
  readonly model: string
  readonly credential: KeyringCredentialInfo
}

/** A key mutation reports a safe failure code and current credential presence. */
export interface HuaweiMaaSKeyResult {
  readonly ok: boolean
  readonly status: HuaweiMaaSStatus
  readonly failure?: KeyringFailureCode
}
