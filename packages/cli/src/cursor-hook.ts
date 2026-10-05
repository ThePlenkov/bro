/**
 * Cursor hook schema ↔ the shared `bro hooks` contract.
 *
 * Cursor sends its own stdin (`cursor_version`, `conversation_id`,
 * `hook_event_name`, shell `command` at the top level, `loop_count` on
 * stop) and reads `additional_context` / `followup_message` / `permission`.
 * The handlers stay Claude-shaped; this module is the edge.
 */
export const CURSOR_SELF_TOOL_MATCHER =
  String.raw`^\s*(bro|bd)(\s|$)|^\s*npx\s+(-y\s+)?@broject/bro(@[\w.:-]+)?(\s|$)`

/** Hint marker under hooks/hinted — not a gate aspect (`readArmed` only
 * scans the hooks dir's top level). */
export const CURSOR_HYDRATED_SKILL = 'cursor-session'

export interface BroHookInput {
  tool_name?: string
  tool_input?: {
    command?: string
    file_path?: string
    path?: string
    files?: string[]
  }
  tool_response?: { success?: boolean }
  prompt?: string
  stop_hook_active?: boolean
  session_id?: string
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

function stringList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) {
    return undefined
  }
  const out = v.filter((x): x is string => typeof x === 'string')
  return out.length > 0 ? out : undefined
}

/** Cursor's common schema carries `cursor_version`. A payload that only
 * has `hook_event_name` plus `conversation_id` still counts — both are
 * Cursor fields, and neither is on the Claude/Devin stdin. */
export function isCursorHookPayload(raw: unknown): boolean {
  if (!isRecord(raw)) {
    return false
  }
  if (typeof raw.cursor_version === 'string') {
    return true
  }
  return typeof raw.hook_event_name === 'string' && typeof raw.conversation_id === 'string'
}

export function cursorWorkspaceRoots(raw: unknown): string[] {
  if (!isRecord(raw) || !Array.isArray(raw.workspace_roots)) {
    return []
  }
  return raw.workspace_roots.filter((r): r is string => typeof r === 'string' && r !== '')
}

/** Aborted and errored turns never gate — a follow-up would reopen a
 * turn the user already cancelled. */
export function cursorStopIgnored(raw: unknown): boolean {
  if (!isRecord(raw) || raw.hook_event_name !== 'stop') {
    return false
  }
  return raw.status === 'aborted' || raw.status === 'error'
}

function commandOf(raw: Record<string, unknown>): string | undefined {
  const nested = isRecord(raw.tool_input) ? str(raw.tool_input.command) : undefined
  const top = str(raw.command)
  // before/after shell put the command at the top level. postToolUse
  // nests it; a top-level `command` there would be something else.
  if (
    raw.hook_event_name === 'beforeShellExecution' ||
    raw.hook_event_name === 'afterShellExecution'
  ) {
    return top ?? nested
  }
  return nested ?? top
}

function successOf(raw: Record<string, unknown>): boolean | undefined {
  switch (raw.hook_event_name) {
    case 'postToolUse':
    case 'afterShellExecution':
      return true
    case 'postToolUseFailure':
      return false
    default:
      return undefined
  }
}

/** Map one Cursor payload onto the stdin the handlers already understand.
 * `loop_count > 0` is Cursor's "this stop already continued once", the
 * same signal as Claude's `stop_hook_active`. */
export function cursorToHookInput(raw: unknown): BroHookInput {
  if (!isRecord(raw)) {
    return {}
  }
  const nested = isRecord(raw.tool_input) ? raw.tool_input : undefined
  const command = commandOf(raw)
  const filePath = str(nested?.file_path) ?? str(raw.file_path)
  const path = str(nested?.path)
  const files = stringList(nested?.files)
  const input: BroHookInput = {}
  const toolName = str(raw.tool_name)
  if (toolName) {
    input.tool_name = toolName
  }
  if (command || filePath || path || files) {
    input.tool_input = { command, file_path: filePath, path, files }
  }
  const success = successOf(raw)
  if (success !== undefined) {
    input.tool_response = { success }
  }
  const prompt = str(raw.prompt)
  if (prompt) {
    input.prompt = prompt
  }
  const sessionId = str(raw.session_id) ?? str(raw.conversation_id)
  if (sessionId) {
    input.session_id = sessionId
  }
  if (
    raw.hook_event_name === 'stop' &&
    typeof raw.loop_count === 'number' &&
    raw.loop_count > 0
  ) {
    input.stop_hook_active = true
  }
  return input
}

/** Claude control JSON → the fields Cursor documents. `decision: block`
 * becomes one follow-up. Prompt context keeps `continue: true` so a
 * strict beforeSubmitPrompt parser still lets the turn through, and
 * repeats the Claude `hookSpecificOutput` shape Cursor also accepts. */
export function toCursorHookOutput(out: unknown): unknown {
  if (!isRecord(out)) {
    return {}
  }
  if (typeof out.permission === 'string') {
    return { permission: out.permission }
  }
  if (out.decision === 'block' && typeof out.reason === 'string') {
    return { followup_message: out.reason }
  }
  if (out.decision === 'approve') {
    return { permission: 'allow' }
  }
  const specific = isRecord(out.hookSpecificOutput) ? out.hookSpecificOutput : undefined
  const text = specific && typeof specific.additionalContext === 'string'
    ? specific.additionalContext
    : undefined
  if (text === undefined) {
    return {}
  }
  if (specific?.hookEventName === 'UserPromptSubmit') {
    return {
      continue: true,
      additional_context: text,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: text,
      },
    }
  }
  return { additional_context: text }
}
