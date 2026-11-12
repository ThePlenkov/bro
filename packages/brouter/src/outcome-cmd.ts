/**
 * `brouter outcome` — report how a routed decision went (spec
 * bro-0ykhg.4).
 *
 * The router journals every route/ask/spawn decision under a UUID; bro
 * (or any reporter holding the credential) reports the terminal
 * verdict back by that id:
 *
 *   brouter outcome <decisionId> --result merged|failed|abandoned|parked \
 *     [--rounds N] [--threads N] [--cost USD] [--tokens N] [--wall-ms N] \
 *     [--event ID] [--token T] [--json]
 *
 * A bare CLI submission lands as PENDING — stored, never counted —
 * unless it presents the store's reporter credential (`--token` or
 * BROUTER_REPORTER_TOKEN... see below). bro's trusted reporter uses the
 * library seam with its own verification instead.
 */
import { flag, positionals } from '@broject/core';
import {
  migrateStore,
  openStore,
  OUTCOME_RESULTS,
  recordOutcome,
  routerStorePath,
} from '@broject/router-store';
import type { OutcomeResult } from '@broject/router-store';
import { randomUUID } from 'node:crypto';

/** The env var an operator exports the reporter credential through —
 *  never a flag value in shell history when the env can carry it. */
const TOKEN_ENV = 'BRO_ROUTER_REPORTER_TOKEN';

/** A non-negative integer flag — undefined when absent, an error exit
 *  when malformed (the measure contract is validated store-side too;
 *  the CLI fails before the store ever sees a bad number). */
function intFlag(argv: string[], name: string): number | undefined {
  const raw = flag(argv, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    console.error(
      `brouter outcome: ${name} must be a non-negative integer — got ${JSON.stringify(raw)}`
    );
    process.exit(2);
  }
  return value;
}

/** A non-negative finite flag — cost and wall-ms allow fractions? No:
 *  wall-ms is integral; cost is a USD amount (finite, non-negative). */
function numFlag(argv: string[], name: string): number | undefined {
  const raw = flag(argv, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    console.error(
      `brouter outcome: ${name} must be a finite non-negative number — got ${JSON.stringify(raw)}`
    );
    process.exit(2);
  }
  return value;
}

/** The outcome surface — `brouter outcome <decisionId> ...`. */
export async function runOutcomeCommand(argv: string[]): Promise<void> {
  const decisionId = positionals(
    argv,
    new Set([
      '--result',
      '--rounds',
      '--threads',
      '--cost',
      '--tokens',
      '--wall-ms',
      '--event',
      '--token',
      '--json',
      '--path',
    ])
  )[0];
  if (decisionId === undefined) {
    console.error(
      `usage: brouter outcome <decisionId> --result ${OUTCOME_RESULTS.join('|')} ` +
        '[--rounds N] [--threads N] [--cost USD] [--tokens N] [--wall-ms N] [--json]'
    );
    process.exit(2);
  }
  const result = flag(argv, '--result') as OutcomeResult | undefined;
  if (result === undefined || !OUTCOME_RESULTS.includes(result)) {
    console.error(`brouter outcome: --result must be one of ${OUTCOME_RESULTS.join('|')}`);
    process.exit(2);
  }
  const path = flag(argv, '--path') ?? routerStorePath();
  const handle = openStore(path);
  if (!handle.ok) {
    console.error(`brouter outcome: the ledger is unavailable — ${handle.reason}`);
    process.exit(1);
  }
  try {
    migrateStore(handle.db);
    const token = flag(argv, '--token') ?? process.env[TOKEN_ENV];
    const rounds = intFlag(argv, '--rounds');
    const threads = intFlag(argv, '--threads');
    const tokens = intFlag(argv, '--tokens');
    const cost = numFlag(argv, '--cost');
    const wallMs = intFlag(argv, '--wall-ms');
    const recorded = await recordOutcome(
      handle,
      {
        decisionId,
        result,
        ...(rounds === undefined ? {} : { rounds }),
        ...(threads === undefined ? {} : { threads }),
        ...(tokens === undefined ? {} : { tokens }),
        ...(cost === undefined ? {} : { cost }),
        ...(wallMs === undefined ? {} : { wallMs }),
        reporter: 'brouter-cli',
        eventId: flag(argv, '--event') ?? randomUUID(),
        sourceId: 'brouter-cli',
        sourceRevision: Date.now(),
      },
      {
        ...(token === undefined ? {} : { credential: token }),
      }
    );
    if (argv.includes('--json')) {
      console.log(JSON.stringify(recorded, null, 2));
      return;
    }
    const state =
      recorded.applied === 'duplicate-event'
        ? 'duplicate — already recorded'
        : recorded.verified
          ? recorded.applied
          : 'pending — unverified, excluded from stats until a trusted reporter confirms';
    console.log(`outcome ${decisionId}: ${recorded.outcome?.result ?? result} — ${state}`);
  } finally {
    handle.close();
  }
}
