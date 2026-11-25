import type { FleetProfile } from '@broject/core';

/** A profile's `model` is a PAIR with its `provider` — the same rule a
 *  chain[0] `{provider, model}` pin follows. A profile naming another
 *  provider (or no resolved lane) must never leak its model onto the
 *  resolved provider — omp refused exactly such an alien model
 *  (bro-mmmodel). Leaf module: the connector graph's cycles must not
 *  gate a pure pairing rule (bro-1lvvx). */
export function profileModelFor(
  profile: FleetProfile | undefined,
  provider: string | undefined
): string | undefined {
  return profile !== undefined && profile.provider === provider ? profile.model : undefined;
}
