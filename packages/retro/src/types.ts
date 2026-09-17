export interface BeadRow {
  id: string
  title: string
  status: string
  labels?: string[]
  updated_at?: string
}

/** Scope decides where a finding must be persisted to actually prevent
 * recurrence — mirrors the retrospect skill's scope table. */
export const RETRO_SCOPES = ['universal', 'project', 'user', 'agent', 'session'] as const
export type RetroScope = (typeof RETRO_SCOPES)[number]

/** Where a follow-up action lands. Every action becomes a prevention bead;
 * the sink label tells the executor which resource to write to. */
export const ACTION_SINKS = [
  'backlog',
  'memory',
  'agentic-documents',
  'upstream-issue',
  'workaround',
] as const
export type ActionSink = (typeof ACTION_SINKS)[number]

export interface RetroAction {
  title: string
  sink: ActionSink
  scope?: RetroScope
  detail?: string
}

export interface RetroPlan {
  what: string
  why: string
  scope: RetroScope
  /** Open wtf bead this retro answers — closed on record. */
  wtf?: string
  evidence: string[]
  actions: RetroAction[]
}

export interface RecordResult {
  retroId: string
  actionIds: string[]
  closedWtf?: string
}
