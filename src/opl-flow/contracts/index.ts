export type OplFlowCarrier = 'codex' | 'antigravity' | 'dsh'
export type OplFlowJumpMode = 'native_switch' | 'launch_new' | 'external_focus_only'
export type OplFlowTabId =
  | 'needs_action'
  | 'safe_to_archive'
  | 'active_objectives'
  | 'active_sessions'
  | 'blocked'
  | 'backlog'
  | 'pending_events'

export interface OplFlowAvailability {
  available: boolean
  instanceName?: string | undefined
  configPath?: string | undefined
  scriptPath?: string | undefined
  reason?: string | undefined
}

export interface OplFlowServiceSnapshot {
  schema?: string | undefined
  platform?: string | undefined
  label?: string | undefined
  installed?: boolean | undefined
  running?: boolean | undefined
  bridge?: string | null | undefined
}

export interface OplFlowInboxEntry {
  bead_id: string
  title: string
  status?: string | undefined
  execution_mode?: string | null | undefined
  execution_carrier?: string | null | undefined
  preferred_adapter?: string | null | undefined
  bound_session_ref?: string | null | undefined
  category?: string | undefined
  first_blocker?: string | null | undefined
  next_action?: string | null | undefined
  remaining?: string[] | undefined
  remaining_count?: number | undefined
  archive_performed?: boolean | undefined
  user_approval_required?: boolean | undefined
  workspace_path?: string | null | undefined
  session_id?: string | null | undefined
  thread_id?: string | null | undefined
  jump_mode?: OplFlowJumpMode | undefined
}

export interface OplFlowSessionEntry {
  session_ref: string
  carrier: string
  surface?: string | undefined
  is_subagent?: boolean | undefined
  harness?: string | undefined
  model_label?: string | undefined
  title?: string | undefined
  workspace_label?: string | null | undefined
  workspace_path?: string | null | undefined
  session_id?: string | null | undefined
  thread_id?: string | null | undefined
  jump_mode?: OplFlowJumpMode | undefined
  status?: string | undefined
  updated_at?: string | undefined
  bound_bead_id?: string | null | undefined
}

export interface OplFlowPendingEvent {
  event_id: string
  event_type: string
  objective_id: string
  source?: string | undefined
  status?: string | undefined
  created_at?: string | undefined
  summary?: string | undefined
}

export interface OplFlowWorkspaceOccupant {
  workspace_label: string
  workspace_path?: string | undefined
  carrier: string
  harness?: string | null | undefined
  session_ref: string
  session_id?: string | null | undefined
  bound_bead_id?: string | null | undefined
}

export interface OplFlowDashboardCounts {
  needs_action: number
  safe_to_archive: number
  active_objectives: number
  active_sessions: number
  running_sessions?: number | undefined
  primary_sessions?: number | undefined
  subagent_sessions?: number | undefined
  unique_occupied_workspaces?: number | undefined
  collision_workspaces?: number | undefined
  blocked: number
  backlog: number
  pending_events: number
  total_objectives?: number | undefined
}

export interface OplFlowDashboardData {
  schema?: string | undefined
  instance_name?: string | undefined
  fetched_at?: string | undefined
  service: OplFlowServiceSnapshot
  counts: OplFlowDashboardCounts
  inbox: {
    needs_action?: OplFlowInboxEntry[] | undefined
    safe_to_archive?: OplFlowInboxEntry[] | undefined
    active_objectives?: OplFlowInboxEntry[] | undefined
    active_sessions?: OplFlowSessionEntry[] | undefined
    active_workspace_occupants?: OplFlowWorkspaceOccupant[] | undefined
    blocked?: OplFlowInboxEntry[] | undefined
    backlog?: OplFlowInboxEntry[] | undefined
    pending_events?: OplFlowPendingEvent[] | undefined
  }
  active_sessions?:
    | {
        sessions?: OplFlowSessionEntry[] | undefined
        active_workspace_occupants?: OplFlowWorkspaceOccupant[] | undefined
      }
    | undefined
  validation_errors?: string[] | undefined
}

export interface OplFlowDashboardEnvelope {
  ok?: boolean | undefined
  state: 'ready' | 'unavailable' | 'error'
  reason?: string | undefined
  data?: OplFlowDashboardData | undefined
  error?: { code?: string | undefined; message?: string | undefined } | undefined
}

export interface OplFlowSendRequest {
  message: string
  objective_id?: string | undefined
  title?: string | undefined
  executor?: OplFlowCarrier | undefined
  execution_mode?: 'active' | 'backlog' | undefined
  now?: boolean | undefined
}

export interface OplFlowApproveRequest {
  bead_id: string
  approved_by?: string | undefined
  confirmed: boolean
}

export interface OplFlowTickRequest {
  dry_run?: boolean | undefined
}

export interface OplFlowServiceRequest {
  action: 'status' | 'up' | 'down'
  bridge?: 'auto' | 'codex' | 'antigravity' | undefined
  confirmed?: boolean | undefined
}

export interface OplFlowActionResult {
  ok: boolean
  message?: string | undefined
  bead_id?: string | undefined
  action?: string | undefined
  state?: string | undefined
  bridge?: string | undefined
}
