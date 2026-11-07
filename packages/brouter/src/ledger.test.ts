import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// the ledger is the router's own state — the test's own state dir
const scratch = mkdtempSync(join(tmpdir(), 'brouter-ledger-'));
process.env['XDG_STATE_HOME'] = join(scratch, 'state');
after(() => rmSync(scratch, { recursive: true, force: true }));

const { recordTurn } = await import('./ledger.ts');
const { openSessions, openStore, routerStorePath, storeStats } = await import(
  '@broject/router-store'
);

/** The ledger as it stands — its own counts and its open sessions. */
async function ledger(): Promise<{ sessions: number; open: number }> {
  const handle = openStore(routerStorePath());
  assert.ok(handle.ok);
  const stats = await storeStats(handle.db);
  const open = await openSessions(handle.db);
  handle.close();
  return { sessions: stats.sessions, open: open.length };
}

test('two turns in the same millisecond are two sessions — no ghost', async () => {
  const at = 1_700_000_000_000;
  await recordTurn({ provider: 'devin-acp', model: 'swe-2-max', tokens: 10, now: at });
  await recordTurn({ provider: 'devin-acp', model: 'swe-2-max', tokens: 10, now: at });

  const after = await ledger();
  assert.equal(after.sessions, 2, 'the turns must not share a session');
  assert.equal(after.open, 0, 'a closed turn leaves nothing open');
});

test('a turn the ledger cannot take costs the numbers, never the run', async () => {
  const recorded = await recordTurn({
    provider: 'devin-acp',
    model: 'swe-2-max',
    tokens: 10,
    now: 1_700_000_000_001,
  });
  assert.equal(recorded, true);
});
