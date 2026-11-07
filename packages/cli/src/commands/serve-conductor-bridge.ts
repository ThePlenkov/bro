/**
 * The bridge — an agent's tool call, in the client's vocabulary.
 *
 * The conductor speaks two protocols: Anthropic to the client, ACP to the
 * agent. The agent's tool call arrives in ACP's shape (a `kind`, a raw
 * input); the client executes in its own (a name, a JSON input the
 * request's schema validates). The bridge translates the first into the
 * second — BY CAPABILITY, never by name: the agent calls "execute", the
 * client offers "Bash".
 *
 * A call that cannot be translated stays what it was: a narrated edge.
 * The wire never invents a call the client cannot execute, and it never
 * drops one it can.
 */
import { capabilityOf, matchingTools } from './serve-conductor-capabilities.ts';
import { recordOf, toolInput } from './serve-conductor-bridge-input.ts';
import { bridgeable } from './serve-conductor-bridge-status.ts';
import type { ClientTool } from './serve-conductor-tools.ts';

/** The ACP tool call, as the update carries it. */
export interface AcpToolCall {
  sessionUpdate: string;
  kind?: string | null;
  rawInput?: unknown;
  toolCallId?: string;
  /** the call's own status — a call that arrives already terminal has
   *  run, and a report is not a request */
  status?: string | null;
}

/** The client's tool call — the name and the input the client executes. */
export interface ClientCall {
  /** the client's tool name */
  name: string;
  /** the input, in the client's schema */
  input: Record<string, unknown>;
  /** the ACP call's id — the call's narration is the client's now */
  toolCallId?: string;
}

/** The request's tool contract — what the client allowed. A request that
 *  withheld its tools (tool_choice: none) allows no call at all; a request
 *  that NAMED a tool allows that one and no other. */
export interface ToolContract {
  /** false when the request withheld the tool contract */
  allowed: boolean;
  /** the tool the request named — undefined when it named none */
  name?: string;
}

/** The contract of a request that said nothing about its tools. */
export const OPEN_CONTRACT: ToolContract = { allowed: true };

/** The capability the call asks for — undefined when the request withheld
 *  its tools, when the call is one the bridge may not hand over, or when
 *  it names a capability this client does not have. */
function wantedCapability(u: AcpToolCall, contract: ToolContract): string[] | undefined {
  if (!contract.allowed) return undefined;
  if (!bridgeable(u)) return undefined;
  return capabilityOf(u.kind);
}

/** The first candidate whose input the client's schema accepts — the tool
 *  and the input that goes with it. */
function runnableTool(
  candidates: ClientTool[],
  raw: Record<string, unknown>
): { tool: ClientTool; input: Record<string, unknown> } | undefined {
  for (const tool of candidates) {
    const input = toolInput(tool, raw);
    if (input !== undefined) return { tool, input };
  }
  return undefined;
}

/** The ACP tool call → the client's tool call — undefined when the client
 *  offers no tool that can run it, or when the request's own contract
 *  allows no call. */
export function clientCall(
  u: AcpToolCall,
  tools: ClientTool[],
  contract: ToolContract = OPEN_CONTRACT
): ClientCall | undefined {
  const wanted = wantedCapability(u, contract);
  if (wanted === undefined) return undefined;
  const raw = recordOf(u.rawInput);
  if (raw === undefined) return undefined;
  const hit = runnableTool(matchingTools(wanted, tools, contract.name), raw);
  if (hit === undefined) return undefined;
  return { name: hit.tool.name, input: hit.input, toolCallId: u.toolCallId };
}
