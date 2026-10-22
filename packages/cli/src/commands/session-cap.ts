/**
 * The session cap at the two call sites the admission does not cover
 * (spec bro-bww9v).
 *
 * The admission (bro's own spawn) has always enforced
 * `agents.<kind>.maxSessions` — but a cap about the ACCOUNT is enforced
 * at every place the account is spent, and two of them were open:
 *
 *  - the GUARD PLANE: a tool call about to start a vendor session (an
 *    agent running the CLI in its own worktree). The pre-tool verdict
 *    vetoes the call when the kind is at its cap. A hook fails OPEN: a
 *    count that cannot be established lets the call through — a hook
 *    must never stall the client (REVIEW.md).
 *  - the ACP SURFACE: the conductor's session facade. Every request
 *    opens a session on the shared peer and a retained conversation
 *    keeps one alive — and the plane cannot see those (one acp peer
 *    carries them all under one pid), so the conductor counts its own.
 *
 * The policy itself lives in the core (`@broject/core`'s session-cap
 * module) and the vendor knowledge in the vendor's package; this file
 * is the wiring — which config, which call site, which failure mode.
 */
import { createHash } from 'node:crypto'
import {
  reserveSessionStart,
  sessionCapRefusal,
  sessionCapRefusalFor,
  sessionCapViews,
  sessionStartClaimed,
  type Connector,
  type ConnectorCtx,
  type PreToolVerdict,
  type SessionCapView,
} from '@broject/core'
import { loadAgentEnv } from '../agent-connectors.ts'

/** The refusal for a command about to start sessions, or undefined when
 *  it fits. Throws when the count cannot be established — the CALLER
 *  decides: a quota fails closed, a hook fails open. */
export function sessionCapRefusalForCommand(
  command: string,
  dir: string
): string | undefined {
  const env = loadAgentEnv(dir)
  return sessionCapRefusalFor(command, env.agents)
}

/** The guard plane's verdict for one about-to-run tool call.
 *
 *  Only a command that some plane claims as a session start is judged;
 *  every other tool call passes untouched. The slot is claimed when the
 *  call is ALLOWED, so a burst of parallel starts shares one budget
 *  instead of each seeing the same headroom. */
export function sessionCapVerdict(
  ctx: ConnectorCtx,
  input: { tool: string; input: Record<string, unknown> },
  /** The `agents.<kind>` bags — the cap's knobs. Defaults to the
   *  repo's config; injectable for tests. */
  agents?: Record<string, Record<string, unknown>>
): PreToolVerdict[] {
  const command = typeof input.input['command'] === 'string' ? input.input['command'] : ''
  if (command.trim() === '') {
    return []
  }
  let bags: Record<string, Record<string, unknown>>
  try {
    bags = agents ?? loadAgentEnv(ctx.dir).agents
  } catch {
    // the config could not be read — a hook fails OPEN
    return []
  }
  let views: SessionCapView[]
  try {
    views = sessionCapViews(command, bags)
  } catch {
    // the count could not be established — a hook fails OPEN
    return []
  }
  // The claim's key carries the command, so a client that asks twice
  // (a pre-tool AND a permission event for the same call) claims ONE
  // slot, not two — and the second run does not count its own start
  // again (the claim is already in the live count).
  const key = `guard-${ctx.sessionId ?? 'nosession'}-${commandKey(command)}`
  for (const view of views) {
    const claimed = sessionStartClaimed(view.kind, bags, key)
    const refusal = sessionCapRefusal(
      claimed ? { ...view, starts: 0 } : view
    )
    if (refusal !== undefined) {
      return [{ block: refusal }]
    }
  }
  // allowed — claim the slots this start will take
  for (const view of views) {
    try {
      reserveSessionStart({ kind: view.kind, agents: bags, key, count: view.starts })
    } catch {
      // the claim is a brake, not a gate — the call still runs
    }
  }
  return []
}

/** A short digest of a command — the claim's key half. The same
 *  command claims the same slot; a different one claims its own. */
function commandKey(command: string): string {
  return createHash('sha1').update(command).digest('hex').slice(0, 12)
}

/** The refusal for a command, from the hook's point of view.
 *
 *  The devin client sends no pre-tool event: its veto point is the
 *  PERMISSION request (the plugin's PermissionRequest hook). The cap
 *  has to run there too, or the very population the incident came
 *  from — an agent starting vendor sessions in its own worktree — walks
 *  past the cap untouched.
 *
 *  Fails OPEN: a hook must never stall the client (REVIEW.md). */
export function sessionCapRefusalForHook(
  command: string,
  dir: string,
  sessionId?: string,
  /** The `agents.<kind>` bags — injectable for tests. */
  agents?: Record<string, Record<string, unknown>>
): string | undefined {
  try {
    const ctx = { dir, sessionId } as ConnectorCtx
    const verdicts = sessionCapVerdict(ctx, { tool: 'exec', input: { command } }, agents)
    return verdicts[0]?.block
  } catch {
    return undefined
  }
}

/** The conductor's own budget — the ACP surface's session facade.
 *
 *  The plane counts live devin PROCESSES; the conductor's retained
 *  conversations share one peer process, so the plane sees one where
 *  the conductor holds many. The conductor adds its own count on top
 *  (the shared peer is already in the plane's count, so the budget errs
 *  low, never high). */
export function conductorSessionRefusal(
  view: SessionCapView | undefined,
  retained: number,
  starts = 1
): string | undefined {
  if (view === undefined) {
    return undefined
  }
  return sessionCapRefusal({ ...view, live: view.live + retained, starts })
}

/** The connector — the guard plane's veto for a session start. */
export const sessionCapConnector: Connector = {
  name: 'session-cap',
  hooks: () => ({
    preTool(ctx, input) {
      return sessionCapVerdict(ctx, input)
    },
  }),
}
