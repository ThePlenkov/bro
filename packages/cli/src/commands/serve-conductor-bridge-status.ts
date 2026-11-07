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
  return call.sessionUpdate === 'tool_call' && !TERMINAL.has(call.status ?? '');
}
