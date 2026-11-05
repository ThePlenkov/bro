/**
 * `brouter store` — the router's own ledger: where it lives, what it
 * holds, and how to bring it up to date.
 *
 * The ledger is the router's state (spec bro-olfvd.1): the traffic it
 * served, the rate limit it saw, the sessions it holds. Every write
 * elsewhere is best-effort, so the store is asked for, not imposed.
 */
import { flag } from '@broject/core';
import { migrateStore, openStore, routerStorePath, storeStats } from '@broject/router-store';
import type { StoreHandle } from '@broject/router-store';

const VERBS = ['path', 'migrate', 'stats'];

/** The ledger's path — the flag wins over the XDG default. */
function ledgerPath(argv: string[]): string {
  return flag(argv, '--path') ?? routerStorePath();
}

/** Open the ledger, or fail with the reason — the operator asked for it. */
function openOrFail(path: string): Extract<StoreHandle, { ok: true }> {
  const handle = openStore(path);
  if (!handle.ok) {
    console.error(`brouter store: the ledger is unavailable — ${handle.reason}`);
    process.exit(1);
  }
  return handle;
}

/** `migrate` — apply the pending migrations and report what ran. */
async function migrate(path: string, json: boolean): Promise<void> {
  const handle = openOrFail(path);
  try {
    const applied = migrateStore(handle.db);
    if (json) {
      console.log(JSON.stringify({ path, applied }, null, 2));
      return;
    }
    console.log(
      applied.length === 0 ? 'the ledger is up to date' : `applied ${applied.join(', ')}`
    );
  } finally {
    handle.close();
  }
}

/** `stats` — what the ledger holds. */
async function stats(path: string, json: boolean): Promise<void> {
  const handle = openOrFail(path);
  try {
    const counts = await storeStats(handle.db);
    if (json) {
      console.log(JSON.stringify({ path, ...counts }, null, 2));
      return;
    }
    console.log(
      `${counts.usage} usage row(s)\t${counts.limits} wall(s)\t${counts.sessions} session(s)`
    );
  } finally {
    handle.close();
  }
}

/** The store's surface — `brouter store path|migrate|stats`. */
export async function runStoreCommand(argv: string[]): Promise<void> {
  const verb = argv[0] ?? 'path';
  const path = ledgerPath(argv);
  const json = argv.includes('--json');
  if (verb === 'path') {
    console.log(json ? JSON.stringify({ path }, null, 2) : path);
    return;
  }
  if (!VERBS.includes(verb)) {
    console.error(`brouter store: unknown verb "${verb}" — ${VERBS.join(' | ')}`);
    process.exit(2);
  }
  if (verb === 'migrate') {
    await migrate(path, json);
    return;
  }
  await stats(path, json);
}
