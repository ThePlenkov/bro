/** --wait's provider resolution — pin or routed lane to an acp-typed
 *  entry, then the wall gate. Walls live in the repo registry; a
 *  delegate turn is automated spend, so it refuses on walls the
 *  interactive lane might ride through. (spec bro-z8tng) */
import { SpawnError, wallText, type ProviderEntry, type ResolvedClass } from '@broject/core';
import type { AcpWallCheck, AcpWallRefusal } from '@broject/providers';
import { providerWallsFor, type AgentConnectorEnv } from '../agent-connectors.ts';
import { SpawnInputError } from './agents.ts';
import { type DelegateRequest } from './delegate.ts';

/** --wait's provider name: the pin wins, else the routed chain head. */
export function waitProviderName(req: DelegateRequest, routed: ResolvedClass | undefined): string {
  const name = req.provider ?? routed?.provider;
  if (name === undefined) {
    throw new SpawnInputError(
      'delegate --wait needs a provider — pass --provider <name> or declare fleet.routing.<class>.chain'
    );
  }
  return name;
}

/** The provider's entry — must be acp-typed: a pooled turn needs an
 *  ACP peer, api/cli kinds have no session to converse over. A
 *  missing entry is the caller's bug when they pinned it, config when
 *  the lane resolved to it. */
export function acpEntry(
  env: AgentConnectorEnv,
  name: string,
  pinned: boolean
): Extract<ProviderEntry, { type: 'acp' }> {
  const entry = env.providers?.[name];
  if (entry === undefined) {
    throw new SpawnError(`providers.${name} is not configured`, pinned ? 'input' : 'config');
  }
  if (entry.type !== 'acp') {
    throw new SpawnError(
      `providers.${name} (type '${entry.type}') cannot serve a delegate turn — --wait needs an 'acp' provider`,
      'config'
    );
  }
  return entry;
}

/** Provider walls live in the repo registry — a non-repo dir reads as
 *  no walls (readAgentRegistry returns {} for ENOENT/no-common-dir), so
 *  any throw IS registry corruption: fail the wait closed rather than
 *  spend against a provider whose wall status is unknown. */
function wallsFor(dir: string): ReturnType<typeof providerWallsFor> {
  try {
    return providerWallsFor(dir);
  } catch (err) {
    throw new SpawnError(
      `provider walls unreadable — refusing the delegate turn closed: ${err instanceof Error ? err.message : String(err)}`,
      'unavailable'
    );
  }
}

/** The wall gate — a hit refuses the turn before any ACP spend. */
export function refuseWalled(dir: string, provider: string): void {
  const wall = wallsFor(dir).find(w => w.provider === provider);
  if (wall !== undefined) {
    throw new SpawnError(`${wallText(wall)} — ${DELEGATE_WALL_WAIT}`, 'cap');
  }
}

const DELEGATE_WALL_WAIT =
  'the delegate lane waits; retry after the reset or --detach to a different lane';
/** A wall with no advertised end gets a modest retry hint — the
 *  refusal already names the cause; the number is advice, not a
 *  promise. */
const DELEGATE_WALL_RETRY_SEC = 60;

/** The fleet's registry/ledger walls AS the turn's admission check
 *  (spec bro-acjzf): `refusal()` is re-read inside `acpSessionOpen`,
 *  immediately before `session/new` spends — a wall a concurrent
 *  worker lands between `refuseWalled` and the open still refuses the
 *  turn, for free (no session, no quota). The reason carries the same
 *  text the early gate's SpawnError carries, so the refusal reads the
 *  same wherever it is caught. */
export function delegateWallCheck(dir: string, provider: string): AcpWallCheck {
  return {
    refusal: (now = Date.now()): AcpWallRefusal | undefined => {
      const wall = wallsFor(dir).find(w => w.provider === provider);
      if (wall === undefined) {
        return undefined;
      }
      const untilMs = wall.until === undefined ? Number.NaN : Date.parse(wall.until);
      const retryAfterSec = Number.isFinite(untilMs)
        ? Math.max(1, Math.ceil((untilMs - now) / 1000))
        : DELEGATE_WALL_RETRY_SEC;
      return { reason: `${wallText(wall)} — ${DELEGATE_WALL_WAIT}`, retryAfterSec };
    },
  };
}
