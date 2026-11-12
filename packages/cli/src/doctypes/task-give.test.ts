/** `bro task give` — fleet F4 (specs/bro-izpyk.4.md §2): resolve the
 *  fleet target BEFORE creating the bead (an ambiguous target must not
 *  leave an orphan), assign through the store's update path (never
 *  claim() — that binds the caller's actor), then notify through the
 *  same `bro msg` delivery path.
 *
 *  Isolation note: the ledger connector memoizes ONE facade per
 *  process (`ledgerSingleton` in connectors.ts) — its dbPath freezes at
 *  the first `facade('ledger')` call, so every test in this file shares
 *  ONE XDG_STATE_HOME. Seeded session rows accumulate across tests;
 *  the fixtures below use non-overlapping sids/targets so order never
 *  matters. */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ledgerFacade } from '@broject/core';
import { runDocVerb } from '../docs.ts';
import { capture, initRepo, installFakeBd, readBeads, scrubEnv } from '../commands/testrepo.ts';

// ambient repo/agent/store pins must not reach the fixture's git/bd
// children or the code-under-test's facade resolution
after(scrubEnv());

/** The one machine-state dir every test shares (see header note). */
let sharedStateDir: string | undefined;
function stateDir(): string {
  sharedStateDir ??= mkdtempSync(join(tmpdir(), 'bro-give-state-'));
  return sharedStateDir;
}

after(() => {
  if (sharedStateDir !== undefined) {
    rmSync(sharedStateDir, { recursive: true, force: true });
  }
});

interface GiveFixture {
  root: string;
  main: string;
  db: string;
  restore(): void;
}

/** Repo cwd + fake bd on PATH + the shared machine state dir pinned as
 *  XDG_STATE_HOME (ledger + user mailbox live there). BRO_HOOK_SPOOL=0
 *  keeps the host's live spool out of ledger reads. */
function giveFixture(): GiveFixture {
  const { root, main } = initRepo('bro-give-');
  const beads = join(root, 'beads');
  mkdirSync(beads);
  const { binDir, db } = installFakeBd(beads, []);
  const prev = {
    cwd: process.cwd(),
    PATH: process.env.PATH ?? '',
    FAKE_BD_DB: process.env.FAKE_BD_DB,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    BRO_HOOK_SPOOL: process.env.BRO_HOOK_SPOOL,
  };
  process.env.PATH = `${binDir}:${prev.PATH}`;
  process.env.FAKE_BD_DB = db;
  process.env.XDG_STATE_HOME = stateDir();
  process.env.BRO_HOOK_SPOOL = '0';
  process.chdir(main);
  return {
    root,
    main,
    db,
    restore() {
      process.chdir(prev.cwd);
      process.env.PATH = prev.PATH;
      for (const [k, v] of [
        ['FAKE_BD_DB', prev.FAKE_BD_DB],
        ['XDG_STATE_HOME', prev.XDG_STATE_HOME],
        ['BRO_HOOK_SPOOL', prev.BRO_HOOK_SPOOL],
      ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

/** Seed the machine ledger the give path reads — the same dbPath the
 *  memoized facade resolves under the pinned XDG_STATE_HOME. */
async function seedSession(row: {
  host: string;
  sid: string;
  spawnedBy?: string | null;
  lastSeen?: number;
}): Promise<void> {
  const ledger = ledgerFacade();
  await ledger.append([
    {
      kind: 'session',
      mode: 'observe',
      state: 'live',
      host: row.host,
      sid: row.sid,
      lastSeen: row.lastSeen ?? Date.now(),
      spawnedBy: row.spawnedBy ?? undefined,
    },
  ]);
}

describe('bro task give', () => {
  test('resolved agentId → assignee is the agentId, bead created, msg sent', async () => {
    const f = giveFixture();
    try {
      await seedSession({
        host: 'claude',
        sid: 'give-target-1',
        spawnedBy: 'fixer-9',
      });
      const r = await capture(() => runDocVerb('task', ['give', 'fixer-9', 'ship the widget']));
      assert.equal(r.code, 0, r.err.join('\n'));
      const rows = readBeads(f.db);
      assert.equal(rows.length, 1);
      const bead = rows[0]!;
      assert.equal(bead['title'], 'ship the widget');
      assert.equal(bead['assignee'], 'fixer-9');
      // the notification names the created id — cause/key carry it
      assert.ok(
        r.out.some(l => /msg → .*assigned|task fx-/.test(l)),
        `expected delivery line, got: ${r.out.join(' | ')}`
      );
      assert.ok(r.out.some(l => /task fx-\w+ assigned to fixer-9/.test(l)));
    } finally {
      f.restore();
    }
  });

  test('unresolvable target → raw target is the assignee (mailbox fallback)', async () => {
    const f = giveFixture();
    try {
      const r = await capture(() => runDocVerb('task', ['give', 'ghost-session', 'fallback task']));
      assert.equal(r.code, 0, r.err.join('\n'));
      const rows = readBeads(f.db);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!['assignee'], 'ghost-session');
    } finally {
      f.restore();
    }
  });

  test('ambiguous target dies BEFORE any bead exists', async () => {
    const f = giveFixture();
    try {
      await seedSession({ host: 'claude', sid: 'deadbeef0001' });
      await seedSession({ host: 'codex', sid: 'deadbeef0002' });
      const r = await capture(() => runDocVerb('task', ['give', 'dead', 'must not orphan']));
      assert.notEqual(r.code, 0);
      assert.ok(
        r.err.concat(r.out).some(l => /ambiguous session "dead"/.test(l)),
        `expected ambiguity error, got out=${r.out.join('|')} err=${r.err.join('|')}`
      );
      assert.equal(readBeads(f.db).length, 0, 'no orphan bead may be created');
    } finally {
      f.restore();
    }
  });

  test('missing title is a usage error before any store write', async () => {
    const f = giveFixture();
    try {
      const r = await capture(() => runDocVerb('task', ['give', 'sometarget']));
      assert.notEqual(r.code, 0);
      assert.ok(
        r.err.concat(r.out).some(l => /needs a title/.test(l)),
        `expected title error, got ${r.err.join('|')}`
      );
      assert.equal(readBeads(f.db).length, 0);
    } finally {
      f.restore();
    }
  });
});
