/** Official CLI owns account secrets; only bounded status facts cross to the page. */
export interface MiniMaxAccountStatus {
  installed: boolean
  region: 'cn' | 'global'
  loginState: 'signed-in' | 'signed-out' | 'unknown'
  loginPending: boolean
  pendingRegion?: 'cn' | 'global'
  loginDeadline?: number
}

/** Region affects only an explicitly requested official browser sign-in. */
export interface MiniMaxAccountLoginRequest {
  region: 'cn' | 'global'
}
