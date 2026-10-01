export interface DrillRow {
  id: string
  title: string
  status: string
  priority?: number
  issue_type?: string
  created_at?: string
  updated_at?: string
  labels?: string[]
  notes?: string
  description?: string
  ephemeral?: boolean
}

export interface DrillFrame extends DrillRow {
  parentId?: string
  depth: number
}

export interface DownOptions {
  under?: string
  /** Force a root frame — by default `down` nests under the current leaf. */
  root?: boolean
  ephemeral?: boolean
  type?: string
  priority?: number
  description?: string
}

export interface UpOptions {
  id?: string
  result: string
  prevent?: string[]
  evidence?: string[]
  /** Resolved report dir — set by the caller when a durable md report
   *  should be written (--report, or drill.report.mode deciding yes).
   *  Undefined → no file; the mode/flag policy lives in the CLI. */
  reportDir?: string
}

export interface UpResult {
  closed: string
  preventionIds: string[]
  /** Path of the written report — present only when reportDir was set. */
  reportPath?: string
}
