/**
 * The tool call's own status — a request or a report.
 *
 * An ACP `tool_call` that arrives already TERMINAL has run: the agent
 * did it in its own sandbox, and the update says so. A report is not a
 * request — a `tool_use` for it would make the client execute the same
 * call a second time, on the client's own machine.
 */

/** The statuses that mean the call is over. */
const TERMINAL = new Set(['completed', 'failed']);

/** Whether the call is one the bridge may hand to the client. */
export function bridgeable(call: { sessionUpdate: string; status?: string | null }): boolean {
  if (call.sessionUpdate !== 'tool_call') return false;
  const status = call.status;
  // NO status is in flight — the update says nothing about the call yet,
  // and only a status that names a terminal outcome means it already ran
  if (status === undefined || status === null) return true;
  return !TERMINAL.has(status);
}
