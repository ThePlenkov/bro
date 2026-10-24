/** --wait's provider resolution — pin or routed lane to an acp-typed
 *  entry, then the wall gate. Walls live in the repo registry; a
 *  delegate turn is automated spend, so it refuses on walls the
 *  interactive lane might ride through. (spec bro-z8tng) */
import {
  SpawnError,
  wallText,
  type ProviderEntry,
  type ResolvedClass,
} from '@broject/core'
import {
  providerWallsFor,
  type AgentConnectorEnv,
} from '../agent-connectors.ts'
import { SpawnInputError } from './agents.ts'
import { type DelegateRequest } from './delegate.ts'

/** --wait's provider name: the pin wins, else the routed chain head. */
export function waitProviderName(
  req: DelegateRequest,
  routed: ResolvedClass | undefined
): string {
  const name = req.provider ?? routed?.provider
  if (name === undefined) {
    throw new SpawnInputError(
      'delegate --wait needs a provider — pass --provider <name> or declare fleet.routing.<class>.chain'
    )
  }
  return name
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
  const entry = env.providers?.[name]
  if (entry === undefined) {
    throw new SpawnError(`providers.${name} is not configured`, pinned ? 'input' : 'config')
  }
  if (entry.type !== 'acp') {
    throw new SpawnError(
      `providers.${name} (type '${entry.type}') cannot serve a delegate turn — --wait needs an 'acp' provider`,
      'config'
    )
  }
  return entry
}

/** Provider walls live in the repo registry — a non-repo dir reads as
 *  no walls (readAgentRegistry returns {} for ENOENT/no-common-dir), so
 *  any throw IS registry corruption: fail the wait closed rather than
 *  spend against a provider whose wall status is unknown. */
function wallsFor(dir: string): ReturnType<typeof providerWallsFor> {
  try {
    return providerWallsFor(dir)
  } catch (err) {
    throw new SpawnError(
      `provider walls unreadable — refusing the delegate turn closed: ${err instanceof Error ? err.message : String(err)}`,
      'unavailable'
    )
  }
}

/** The wall gate — a hit refuses the turn before any ACP spend. */
export function refuseWalled(dir: string, provider: string): void {
  const wall = wallsFor(dir).find((w) => w.provider === provider)
  if (wall !== undefined) {
    throw new SpawnError(
      `${wallText(wall)} — the delegate lane waits; retry after the reset or --detach to a different lane`,
      'cap'
    )
  }
}
