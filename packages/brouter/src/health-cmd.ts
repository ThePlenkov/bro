/**
 * `brouter health` — the read-model the route decision reads: can this
 * model serve right now, and if not, why and until when.
 *
 * The ledger holds the facts (the wall the router saw, the sessions it
 * holds); the caps live in the operator's config. So the verdict says
 * "walled until" and "N sessions open" — it does not decide.
 */
import { flag } from '@broject/core';
import type { HealthSnapshot } from '@broject/core';
import { healthSnapshot, migrateStore, openStore, routerStorePath } from '@broject/router-store';

/** One verdict, as the table renders it. */
function row(key: string, verdict: HealthSnapshot[string]): string {
  const state = verdict.available ? 'available' : (verdict.reason ?? 'unavailable');
  const until =
    verdict.until === undefined ? '' : `\tuntil ${new Date(verdict.until).toISOString()}`;
  const sessions = verdict.openSessions === undefined ? '' : `\t${verdict.openSessions} open`;
  return `${key}\t${state}${until}${sessions}`;
}

/** The health surface — `brouter health [--json]`. */
export async function runHealthCommand(argv: string[]): Promise<void> {
  const path = flag(argv, '--path') ?? routerStorePath();
  const handle = openStore(path);
  if (!handle.ok) {
    console.error(`brouter health: the ledger is unavailable — ${handle.reason}`);
    process.exit(1);
  }
  try {
    // a fresh machine must still answer — the tables are what the read needs
    migrateStore(handle.db);
    const snapshot = await healthSnapshot(handle.db);
    if (argv.includes('--json')) {
      console.log(JSON.stringify(snapshot, null, 2));
      return;
    }
    const keys = Object.keys(snapshot).sort((a, b) => a.localeCompare(b));
    for (const key of keys) {
      console.log(row(key, snapshot[key]!));
    }
    if (keys.length === 0) {
      console.log('no walls and no open sessions — every served model is available');
    }
  } finally {
    handle.close();
  }
}
