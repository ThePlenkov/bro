import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  inboxPath,
  modeFilePath,
  writeModeFile,
  type ClaimFacade,
  type ClaimRow,
  type EventInput,
  type EventsFacade,
  type LedgerFacade,
} from '@broject/core';
import { claimArgs, expandResourceWords, runClaimCommand } from './claim.ts';

const root = mkdtempSync(join(tmpdir(), 'bro-claim-test-'));
after(() => rmSync(root, { recursive: true, force: true }));

function fakeClaims(rows: ClaimRow[] = []): ClaimFacade & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async claim(resource, session) {
      calls.push(`claim:${resource}:${session.host}-${session.sid}`);
      return { ok: true };
    },
    async release(resource, session) {
      calls.push(`release:${resource}:${session.host}-${session.sid}`);
    },
    async list() {
      return rows;
    },
  };
}

test('claimArgs parses subs, flags, and positionals', () => {
  assert.deepEqual(claimArgs(['worktree']).sub, 'claim');
  assert.deepEqual(claimArgs(['worktree']).pos, ['worktree']);
  const rel = claimArgs(['release', 'branch:main', '--session', 's1']);
  assert.equal(rel.sub, 'release');
  assert.deepEqual(rel.pos, ['release', 'branch:main']);
  assert.equal(rel.session, 's1');
  const lst = claimArgs(['list', '--project', '--resource', 'role:']);
  assert.equal(lst.sub, 'list');
  assert.equal(lst.project, true);
  assert.equal(lst.resourcePrefix, 'role:');
  assert.equal(claimArgs([]).sub, 'list');
  // `release task bro-1` — sub + two-word shorthand = three positionals
  const relTask = claimArgs(['release', 'task', 'bro-1']);
  assert.equal(relTask.sub, 'release');
  assert.deepEqual(relTask.pos, ['release', 'task', 'bro-1']);
  assert.throws(() => claimArgs(['claim', 'a', 'b', 'c']));
  assert.throws(() => claimArgs(['release', 'task', 'bro-1', 'extra']));
});

test('expandResourceWords maps shorthands and passes URIs through', () => {
  const dir = root;
  assert.equal(expandResourceWords(['worktree'], dir), `worktree:${dir}`);
  assert.equal(expandResourceWords(['task', 'bro-1'], dir), 'task:bro-1');
  assert.equal(expandResourceWords(['pr', '42'], dir), 'pr:42');
  assert.equal(expandResourceWords(['#7'], dir), 'pr:7');
  assert.equal(expandResourceWords(['path', 'src/**'], dir), 'path:src/**');
  assert.match(expandResourceWords(['role', 'orchestrator'], dir), /^role:orchestrator@/);
  assert.equal(expandResourceWords(['worktree:/elsewhere'], dir), 'worktree:/elsewhere');
  assert.throws(() => expandResourceWords(['task'], dir));
  assert.throws(() => expandResourceWords(['pr', 'x'], dir));
  // an unrecognized multi-word positional is a malformed shorthand,
  // never a literal resource URI containing spaces
  assert.throws(() => expandResourceWords(['worktree', '/some/path'], dir));
  assert.throws(() => expandResourceWords(['bogus', 'two', 'words'], dir));
  // a bare word that is no shorthand and carries no `scheme:` is a
  // misspelling — `bro claim brnch` must not mint a `brnch` lease
  assert.throws(() => expandResourceWords(['brnch'], dir));
});

test('glob bound gates acquire, never release', async () => {
  const dir = root;
  const blowup = '*a'.repeat(30) + '*b'; // > MAX_CLAIM_GLOB_WILDCARDS wildcards
  const env = { BRO_SESSION_ID: 'sid-1', CLAUDE_PLUGIN_ROOT: '/p' } as NodeJS.ProcessEnv;
  // acquire rejects pathological globs — shorthand and URI forms alike
  await assert.rejects(
    runClaimCommand(['path', blowup], { dir, env, claims: fakeClaims() }),
    /too complex to evaluate safely/
  );
  await assert.rejects(
    runClaimCommand([`path:${blowup}`], { dir, env, claims: fakeClaims() }),
    /too complex to evaluate safely/
  );
  // release stays reachable for ANY stored path: URI — a claim admitted
  // before the bound existed must not wait on TTL expiry to be freed
  const claims = fakeClaims();
  await runClaimCommand(['release', `path:${blowup}`], { dir, env, claims });
  assert.ok(claims.calls.some(c => c === `release:path:${blowup}:claude-sid-1`));
  // a normal glob still expands
  assert.equal(expandResourceWords(['path', 'src/**/*.ts'], dir), 'path:src/**/*.ts');
});

test('runClaimCommand claims and releases through the facade', async () => {
  const claims = fakeClaims();
  const env = { BRO_SESSION_ID: 'sid-1', CLAUDE_PLUGIN_ROOT: '/p' } as NodeJS.ProcessEnv;
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => logs.push(a.join(' '));
  try {
    await runClaimCommand(['worktree'], { dir: root, env, claims });
    await runClaimCommand(['release', 'worktree'], { dir: root, env, claims });
    await runClaimCommand(['list'], { dir: root, env, claims });
  } finally {
    console.log = orig;
  }
  assert.ok(claims.calls.some(c => c.startsWith('claim:worktree:')));
  assert.ok(claims.calls.some(c => c.startsWith('release:worktree:')));
  assert.ok(logs.some(l => l.includes('no live claims')));
});

test('runClaimCommand refuses without a session id', async () => {
  const claims = fakeClaims();
  await assert.rejects(
    runClaimCommand(['worktree'], { dir: root, env: {} as NodeJS.ProcessEnv, claims }),
    /no session id/
  );
});

// --- bro-izpyk.8: refused claim → observe-mode session inbox note -------------

function holderRow(resource: string): ClaimRow {
  return {
    host: 'codex',
    sid: 'holder-1',
    project: null,
    resource,
    exclusive: true,
    leaseUntil: Date.now() + 60_000,
    claimedAt: Date.now() - 60_000,
  };
}

function refusingClaims(row: ClaimRow): ClaimFacade {
  return {
    async claim() {
      return { ok: false, conflict: row };
    },
    async release() {},
    async list() {
      return [row];
    },
  };
}

/** Ledger stub naming the caller's session row — the msg path then
 *  delivers through the real inbox file under XDG_STATE_HOME. */
function ledgerWithCaller(host: string, sid: string): LedgerFacade {
  return {
    sessions: async () => [
      {
        kind: 'session' as const,
        mode: 'observe' as const,
        state: 'live' as const,
        host,
        sid,
        project: null,
        cwd: null,
        branch: null,
        pid: null,
        pidStart: null,
        started: null,
        lastSeen: Date.now() - 60_000,
        spawnedBy: null,
      },
    ],
    append: async () => {},
    drainWarning: () => undefined,
  } as unknown as LedgerFacade;
}

function recordingEvents(): { events: EventsFacade; published: EventInput[] } {
  const published: EventInput[] = [];
  return {
    published,
    events: {
      async publish(e: EventInput) {
        published.push(e);
        return { published: true, locator: `loc-${published.length}` };
      },
      async subscribe() {
        return { close() {} };
      },
      async probe() {
        return { events: [], gapped: false };
      },
    },
  };
}

test('a refused claim in an observe session lands in its inbox', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bro-claim-refused-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const row = holderRow(`worktree:${dir}`);
  const env = {
    BRO_SESSION_ID: 'sid-1',
    CLAUDE_PLUGIN_ROOT: '/p',
    XDG_STATE_HOME: dir,
    BRO_HOOK_SPOOL: '0',
  } as NodeJS.ProcessEnv;
  const { events, published } = recordingEvents();
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => logs.push(a.join(' '));
  try {
    await runClaimCommand(['worktree'], {
      dir,
      env,
      claims: refusingClaims(row),
      ledger: ledgerWithCaller('claude', 'sid-1'),
      events,
    });
  } finally {
    console.log = orig;
    process.exitCode = undefined; // refusal verdict must not poison the suite
  }
  assert.ok(logs.some(l => /claim refused/.test(l)));
  const box = inboxPath(env, 'claude', 'sid-1');
  assert.ok(box !== null && existsSync(box), 'inbox file written');
  const entry = JSON.parse(readFileSync(box!, 'utf8').trim());
  assert.match(entry.text, /claim refused — worktree:.*held by codex-holder-1/);
  assert.equal(published.length, 1);
  assert.equal(published[0]!.to, 'claude:sid-1');
});

test('a refused claim in a code-mode session writes no note', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bro-claim-refused-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const row = holderRow(`worktree:${dir}`);
  const env = {
    BRO_SESSION_ID: 'sid-1',
    CLAUDE_PLUGIN_ROOT: '/p',
    XDG_STATE_HOME: dir,
    BRO_HOOK_SPOOL: '0',
  } as NodeJS.ProcessEnv;
  writeModeFile(modeFilePath(env, 'claude', 'sid-1')!, 'code');
  const { events, published } = recordingEvents();
  const orig = console.log;
  console.log = () => {};
  try {
    await runClaimCommand(['worktree'], {
      dir,
      env,
      claims: refusingClaims(row),
      ledger: ledgerWithCaller('claude', 'sid-1'),
      events,
    });
  } finally {
    console.log = orig;
    process.exitCode = undefined;
  }
  assert.equal(published.length, 0);
  const box = inboxPath(env, 'claude', 'sid-1');
  assert.ok(box === null || !existsSync(box));
});
