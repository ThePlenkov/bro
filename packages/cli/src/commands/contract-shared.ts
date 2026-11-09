import type { ContractDump } from './contract-dump.ts';

export const CONTRACT_VERSION = 1;

/** The committed snapshot — the dump plus the tombstone ledger. */
export interface ContractDoc extends ContractDump {
  removed: Record<string, unknown>;
}

export interface ContractProblem {
  kind: 'breaking' | 'stale' | 'ledger';
  /** canonical path — the BREAKING.md bullet token */
  path: string;
  message: string;
}

export interface Removal {
  path: string;
  value: unknown;
}

/** The committed file and any --dump override are untrusted input —
 *  every walk guards record shape so a malformed file reports drift
 *  instead of crashing. */
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const eqJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Own-property lookup — unlike `map[k]` this never reads inherited
 *  properties (a plugin named `toString` still resolves to its row). */
export const own = (map: Record<string, unknown>, key: string): unknown =>
  Object.getOwnPropertyDescriptor(map, key)?.value;

export const emptyDoc = (): ContractDoc => ({
  version: CONTRACT_VERSION,
  groups: {},
  commands: {},
  removed: {},
});
