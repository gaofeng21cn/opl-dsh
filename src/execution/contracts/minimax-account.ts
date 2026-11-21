/** Official CLI owns account secrets; only bounded status facts cross to the page. */
export interface MiniMaxAccountStatus {
  installed: boolean
  region: 'cn' | 'global'
  /** Local CLI account state; signed-in does not establish online validity. */
  loginState: 'signed-in' | 'signed-out' | 'signing-out' | 'unknown'
  loginPending: boolean
  pendingRegion?: 'cn' | 'global'
  loginDeadline?: number
}

/** Public region identifier shared by account actions and DSH execution settings. */
export interface MiniMaxAccountLoginRequest {
  region: 'cn' | 'global'
}
