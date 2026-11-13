/**
 * Fleet lifecycle fixtures — the claim→registry→spawn→exit boundaries
 * as durable state only: a tmpdir git repo, a hand-written agents.json,
 * `.exit`/`.handle`/`.work`/`bro/work` artifacts, an injected /proc-free
 * pid space. No CLI registry, no process.exit — the same reads the
 * connectors and commands run, now owned by @broject/rig (bro-jamp7).
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ListedWatch } from '@broject/act';
import {
  agentRegistryPath,
  patchAgentRegistry,
  procStat,
  readAgentRegistry,
  SESSION_SLOT_TTL_MS,
  type AgentInfo,
  type AgentRegistryEntry,
  type ClaimRow,
  type TaskRow,
  type TaskStore,
} from '@broject/core';
import {
  acquireOccupancyLocks,
  claimLockPath,
  ensureFixerBead,
  ensureFixerWorktree,
  fixerAttemptSpent,
  fixerBeadFor,
  fixerPrFromRef,
  fixerRef,
  FIXER_LABEL,
  freshOccupancy,
  greenOccupancy,
  isLinkedGitDir,
  occupied,
  recordFixerAttempt,
  registryAgents,
  registryEntryHoldsClaim,
  registryEntryState,
  retireOrphanedWorktree,
  selectReapable,
  supervisedBy,
  worktreeClaim,
  worktreeClaimInfo,
  worktreeGitDir,
  worktreeIdleMs,
  type OccupancyCtx,
} from './index.ts';

// --- fixtures ---------------------------------------------------------------

const GIT_ENV = (() => {
  const env = { ...process.env } as NodeJS.ProcessEnv;
  for (const k of Object.keys(env)) {
    if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|CONFIG|TEMPLATE_DIR)/.test(k)) {
      delete env[k];
    }
  }
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  return env;
})();

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }); // NOSONAR — PATH lookup is the contract
}

/** mkdtemp repo → `main` checkout, git identity, one commit. */
function initRepo(prefix: string): { root: string; main: string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const main = join(root, 'main');
  git(['init', '-q', '-b', 'main', main], root);
  git(['config', 'user.email', 't@t'], main);
  git(['config', 'user.name', 't'], main);
  git(['commit', '-qm', 'init', '--allow-empty'], main);
  return { root, main };
}

const DEAD_PID = 2000000000;

const registryEntry = (over: Record<string, unknown> = {}): AgentRegistryEntry =>
  ({
    agentId: 'a1',
    backend: 'native',
    spawnedAt: '2026-01-01T00:00:00Z',
    ...over,
  }) as AgentRegistryEntry;

const agentInfo = (over: Partial<AgentInfo> = {}): AgentInfo => ({
  id: 'a1',
  molStep: 'bead-1',
  backend: 'native',
  state: 'running',
  ...over,
});

// --- claim → registry → spawn → exit: the crash windows ---------------------

describe('registryEntryState — crash windows', () => {
  test('spawn→pid-patch window: a runId row inside the handshake TTL is spawned, past it lost', () => {
    const fresh = new Date().toISOString();
    const stale = new Date(Date.now() - 2 * SESSION_SLOT_TTL_MS).toISOString();
    assert.equal(
      registryEntryState(null, registryEntry({ runId: 'r1', spawnedAt: fresh })),
      'spawned'
    );
    assert.equal(
      registryEntryState(null, registryEntry({ runId: 'r1', spawnedAt: stale })),
      'lost'
    );
    // pre-runId pid-less row was never mid-handshake
    assert.equal(registryEntryState(null, registryEntry({ spawnedAt: fresh })), 'lost');
  });

  test('spawn→handle-publish window: a live self-published handle proves the worker pid-less', () => {
    const home = mkdtempSync(join(tmpdir(), 'rig-handle-'));
    try {
      writeFileSync(
        join(home, 'a1.r1.handle'),
        `${process.pid} ${procStat(process.pid)?.start ?? ''}`
      );
      const e = registryEntry({ agentId: 'a1', runId: 'r1', spawnedAt: '2000-01-01T00:00:00Z' });
      assert.equal(registryEntryState(home, e), 'running');
      // a recycled pid stops proving — the published start disambiguates
      writeFileSync(join(home, 'a1.r1.handle'), `${process.pid} 1`);
      assert.equal(registryEntryState(home, e), 'lost');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('registry→exit: recorded death is terminal; a wall cause reads blocked', () => {
    assert.equal(registryEntryState(null, registryEntry({ exitStatus: 0 })), 'exited');
    assert.equal(
      registryEntryState(null, registryEntry({ exitStatus: 1, cause: 'rate_limited' })),
      'blocked'
    );
    assert.equal(registryEntryState(null, registryEntry({ stopped: true })), 'stopped');
  });

  test('unharvested .exit still proves the exit — and the verdict is stable across re-reads', () => {
    const home = mkdtempSync(join(tmpdir(), 'rig-exit-'));
    try {
      writeFileSync(join(home, 'a1.exit'), '0');
      const e = registryEntry({ agentId: 'a1' });
      assert.equal(registryEntryState(home, e), 'exited');
      // cleanup idempotency: the same artifacts re-read give the same verdict
      assert.equal(registryEntryState(home, e), 'exited');
      assert.equal(registryEntryState(home, registryEntry({ agentId: 'a2' })), 'lost');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('pid plane: a live pid runs, a dead one is lost', () => {
    assert.equal(registryEntryState(null, registryEntry({ pid: process.pid })), 'running');
    assert.equal(registryEntryState(null, registryEntry({ pid: DEAD_PID })), 'lost');
  });
});

describe('registryEntryHoldsClaim — the litter sweep guard', () => {
  test('terminal reads release the claim; live reads hold it — idempotent', () => {
    const home = mkdtempSync(join(tmpdir(), 'rig-claim-'));
    try {
      const exited = registryEntry({ agentId: 'a1', exitStatus: 0 });
      const lost = registryEntry({ agentId: 'a2', pid: DEAD_PID });
      const running = registryEntry({ agentId: 'a3', pid: process.pid });
      const blocked = registryEntry({ agentId: 'a4', exitStatus: 1, cause: 'quota' });
      for (const e of [exited, lost]) {
        assert.equal(registryEntryHoldsClaim(home, e), false);
        assert.equal(registryEntryHoldsClaim(home, e), false);
      }
      for (const e of [running, blocked]) {
        assert.equal(registryEntryHoldsClaim(home, e), true);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('selectReapable — the prune verdict', () => {
  const backend = (agents: AgentInfo[], degraded?: string) => ({
    conn: { name: 'native' },
    agents,
    degraded,
  });

  test('terminal states reap; live and blocked stay; a degraded backend proves nothing', () => {
    const cutoff = Date.now() - 86_400_000;
    const old = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const { reapable, skipped, expected } = selectReapable(
      [
        backend([
          agentInfo({ molStep: 'done', state: 'exited', spawnedAt: old }),
          agentInfo({ molStep: 'gone', state: 'lost', spawnedAt: old }),
          agentInfo({ molStep: 'down', state: 'stopped', spawnedAt: old }),
          agentInfo({ molStep: 'live', state: 'running', spawnedAt: old }),
          agentInfo({ molStep: 'wall', state: 'blocked', spawnedAt: old }),
          agentInfo({ molStep: 'fresh', state: 'exited', spawnedAt: new Date().toISOString() }),
        ]),
        backend(
          [agentInfo({ molStep: 'degraded', state: 'exited', spawnedAt: old })],
          'list failed'
        ),
      ],
      cutoff
    );
    assert.deepEqual(reapable.sort(), ['done', 'down', 'gone']);
    assert.equal(skipped.length, 1);
    assert.ok(skipped[0]!.includes('list failed'));
    // the identity pin — a respawn between snapshot and removal can't be
    // reaped as the dead predecessor it replaced
    assert.equal(expected.get('done')?.agentId, 'a1');
  });
});

// --- the worktree claim plane -------------------------------------------------

describe('worktree-claim reads', () => {
  test('worktreeGitDir: main checkout dir vs linked .git pointer file', () => {
    const { root, main } = initRepo('rig-wtgit-');
    try {
      assert.equal(worktreeGitDir(main), join(main, '.git'));
      const wt = join(root, 'wt');
      git(['-C', main, 'worktree', 'add', wt, '-b', 'side'], root);
      const gd = worktreeGitDir(wt);
      assert.ok(gd !== null && gd.includes('worktrees'));
      assert.ok(isLinkedGitDir(gd!));
      assert.ok(!isLinkedGitDir(join(main, '.git')));
      assert.notEqual(claimLockPath(wt), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('worktreeClaimInfo: a fresh ownerless marker claims; a dead owner is residue', () => {
    const { root, main } = initRepo('rig-wtclaim-');
    try {
      const gd = worktreeGitDir(main)!;
      const dir = join(gd, 'bro');
      mkdirSync(dir, { recursive: true });
      const marker = join(dir, 'work');
      // ownerless fresh marker — the mtime window decides
      writeFileSync(marker, `${Date.now()}\nsome-bead\n`);
      assert.equal(worktreeClaim(main), 'some-bead');
      const info = worktreeClaimInfo(main);
      assert.equal(info?.detail, 'some-bead');
      assert.equal(info?.owner, null);
      // a dead recorded owner makes even a fresh marker residue
      writeFileSync(marker, `${Date.now()} ${DEAD_PID} 1\nforeign\n`);
      assert.equal(worktreeClaim(main), undefined);
      // a live owner keeps the claim
      const start = procStat(process.pid)?.start ?? '';
      writeFileSync(marker, `${Date.now()} ${process.pid} ${start}\nmine\n`);
      assert.equal(worktreeClaim(main), 'mine');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('worktreeIdleMs: churn moves the clock; a missing tree reads infinite', () => {
    const { root, main } = initRepo('rig-wtidle-');
    try {
      const now = Date.now();
      const idle = worktreeIdleMs(main, now);
      assert.ok(Number.isFinite(idle) && idle >= 0);
      assert.equal(worktreeIdleMs(join(root, 'gone'), now), Number.POSITIVE_INFINITY);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// --- occupancy verdicts --------------------------------------------------------

const occCtx = (over: Partial<OccupancyCtx> = {}): OccupancyCtx => ({
  agents: [],
  branch: 'work/bro-x',
  workDetails: [],
  ...over,
});

describe('occupied / greenOccupancy — durable-state verdicts', () => {
  test('no owners → unoccupied; a live session marker occupies', () => {
    assert.equal(occupied(occCtx()), undefined);
    const ctx = occCtx({ workDetails: [{ detail: 'work/bro-x', mtimeMs: Date.now() }] });
    assert.equal(occupied(ctx), 'session armed work on work/bro-x');
    const g = greenOccupancy(ctx, 60_000);
    assert.equal(g.fresh, 'session armed work on work/bro-x');
  });

  test('a dead-owner claim marker never occupies; green TTL adopts silence', () => {
    const { root, main } = initRepo('rig-occ2-');
    try {
      const wt = join(root, 'pr-wt');
      git(['-C', main, 'worktree', 'add', wt, '-b', 'work/pr1'], root);
      const gd = worktreeGitDir(wt)!;
      mkdirSync(join(gd, 'bro'), { recursive: true });
      // dead owner — residue even when fresh
      writeFileSync(join(gd, 'bro', 'work'), `${Date.now()} ${DEAD_PID} 1\nghost\n`);
      const ctx = occCtx({ worktree: wt, branch: 'work/pr1' });
      assert.equal(occupied(ctx), undefined);
      // live ownerless claim occupies
      writeFileSync(join(gd, 'bro', 'work'), `${Date.now()}\nlive-session\n`);
      assert.match(occupied(ctx) ?? '', /claimed by live-session/);
      // age the marker past the 24h ownerless window — the claim itself
      // is residue and nothing occupies
      const ancient = new Date(Date.now() - 25 * 60 * 60 * 1000);
      utimesSync(join(gd, 'bro', 'work'), ancient, ancient);
      assert.equal(occupied(ctx), undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('supervisedBy: a live foreign watch on the PR is an occupant; drive-kind self-excludes', () => {
    const file = join(tmpdir(), 'rig-watch');
    const watch = { pr: 7, pid: process.pid } as ListedWatch['watch'];
    const listed = { file, alive: true, watch } as ListedWatch;
    assert.equal(supervisedBy([listed], 7), listed);
    assert.equal(supervisedBy([listed], 8), undefined);
    assert.equal(supervisedBy(undefined, 7), undefined);
  });

  test('registryAgents + freshOccupancy read a hand-written agents.json', () => {
    const { main } = initRepo('rig-reg-');
    try {
      const reg = agentRegistryPath(main);
      assert.ok(reg !== null);
      mkdirSync(join(reg, '..'), { recursive: true });
      writeFileSync(
        reg!,
        JSON.stringify({
          'bead-1': {
            agentId: 'w1',
            backend: 'native',
            spawnedAt: new Date().toISOString(),
            pid: process.pid,
          },
          'bead-2': {
            agentId: 'w2',
            backend: 'native',
            spawnedAt: new Date().toISOString(),
            pid: DEAD_PID,
          },
        })
      );
      const agents = registryAgents(main);
      assert.equal(agents.length, 2);
      const byStep = new Map(agents.map(a => [a.molStep, a]));
      assert.equal(byStep.get('bead-1')?.state, 'running');
      assert.equal(byStep.get('bead-2')?.state, 'lost');
      const fresh = freshOccupancy(main, []);
      assert.equal(fresh.agents.length, 2);
      assert.ok(Array.isArray(fresh.watches));
      assert.deepEqual(fresh.claims, []);
    } finally {
      rmSync(join(main, '..'), { recursive: true, force: true });
    }
  });
});

// --- claims rung — the ledger-claims occupancy leg (bro-izpyk.10) ------------

const claimRow = (over: Partial<ClaimRow> = {}): ClaimRow => ({
  resource: 'worktree:/repo/main',
  host: 'devin',
  sid: 'sess-abcd1234',
  project: null,
  exclusive: false,
  leaseUntil: Date.now() + 60_000,
  claimedAt: Date.now() - 5_000,
  ttlMs: 60_000,
  ...over,
});

describe('occupied / greenOccupancy — claims rung (bro-izpyk.10)', () => {
  test('no claims → marker-only read (pre-migration behaviour)', () => {
    assert.equal(occupied(occCtx({ branch: 'work/bro-x', claims: undefined })), undefined);
    assert.equal(occupied(occCtx({ branch: 'work/bro-x', claims: [] })), undefined);
  });

  test('a live worktree:<path> claim on the candidate tree occupies', () => {
    const { root, main } = initRepo('rig-occclaim-');
    try {
      const wt = join(root, 'pr-wt');
      git(['-C', main, 'worktree', 'add', wt, '-b', 'work/pr3'], root);
      const ctx = occCtx({
        branch: 'work/pr3',
        worktree: wt,
        claims: [claimRow({ resource: `worktree:${wt}` })],
      });
      assert.match(occupied(ctx) ?? '', /session sess-abc claims worktree:/);
      // fresh by the heartbeat-renewal stamp (leaseUntil − ttlMs)
      const g = greenOccupancy(ctx, 60_000);
      assert.match(g.fresh ?? '', /claims worktree:/);
      assert.ok((g.silentMs ?? 0) <= 60_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('armed detail matches by slug/branch; unrelated claims stay silent', () => {
    const ctx = occCtx({
      branch: 'work/bro-x',
      claims: [
        claimRow({ resource: 'worktree:/repo/main', detail: 'bro-x' }),
        claimRow({ resource: 'worktree:/repo/main', detail: 'bro-y', sid: 'sess-other' }),
        claimRow({ resource: 'role:orchestrator@proj', sid: 'sess-role' }),
        claimRow({ resource: 'task:bro-x', sid: 'sess-task' }),
      ],
    });
    assert.equal(occupied(ctx), 'session sess-abc claims worktree:/repo/main');
  });

  test('a stale renewal still occupies but reports stale — the TTL adopts silence', () => {
    const stale = claimRow({
      detail: 'bro-x',
      // last renewal an hour ago (leaseUntil − ttlMs), TTL still
      // unexpired — liveness is the facade's job; occupancy reads stamps
      leaseUntil: Date.now() - 3_599_000,
      claimedAt: Date.now() - 3_700_000,
      ttlMs: 1_000,
    });
    const g = greenOccupancy(occCtx({ branch: 'work/bro-x', claims: [stale] }), 60_000);
    assert.equal(g.fresh, undefined);
    assert.match(g.stale ?? '', /claims worktree:/);
  });

  test('pr:<n> claims match the pass PR; branch:<name> matches by name', () => {
    const ctx = occCtx({
      branch: 'work/bro-x',
      pr: 42,
      claims: [claimRow({ resource: 'pr:42' })],
    });
    assert.match(occupied(ctx) ?? '', /claims pr:42/);
    const byBranch = occCtx({
      branch: 'work/bro-x',
      claims: [claimRow({ resource: 'branch:bro-x' })],
    });
    assert.match(occupied(byBranch) ?? '', /claims branch:bro-x/);
  });

  test('retireOrphanedWorktree keeps a claim-held tree', () => {
    const { root, main } = initRepo('rig-retclaim-');
    try {
      git(['checkout', '-qb', 'work/pr11'], main);
      git(['checkout', '-q', 'main'], main);
      const ensured = ensureFixerWorktree(main, 'work/pr11');
      assert.ok(ensured.path !== undefined);
      // no marker on disk — the ledger claim alone is the owner proof
      const occ = retireOrphanedWorktree(
        main,
        11,
        ensured.path!,
        'work/pr11',
        undefined,
        [],
        [claimRow({ resource: `worktree:${ensured.path}` })]
      );
      assert.match(occ ?? '', /claims worktree:/);
      assert.ok(existsSync(ensured.path!));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// --- fixer worktree materialization + orphan retire ---------------------------

describe('ensureFixerWorktree / retireOrphanedWorktree — tmpdir repo', () => {
  test('creates the <repo>--<slug> checkout once, reuses it, retires only when orphaned', () => {
    const { root, main } = initRepo('rig-fixwt-');
    try {
      git(['checkout', '-qb', 'work/pr9'], main);
      git(['checkout', '-q', 'main'], main);
      // no origin — remoteLinear passes on missing refs, addFixerWorktree
      // falls back to a local-branch worktree add
      const first = ensureFixerWorktree(main, 'work/pr9');
      assert.ok(first.path !== undefined, JSON.stringify(first));
      assert.equal(first.created, true);
      const second = ensureFixerWorktree(main, 'work/pr9');
      assert.equal(second.path, first.path);
      assert.equal(second.created, undefined);
      // occupied → the retire keeps the tree and reports the owner. The
      // agent must live in the REGISTRY — freshOccupancy re-reads
      // agents.json under the locks; `known` only inherits probe
      // verdicts for 'spawned' rows, it is not an agent source.
      patchAgentRegistry(main, 'bead-1', {
        agentId: 'w1',
        backend: 'native',
        spawnedAt: new Date().toISOString(),
        pid: process.pid,
        worktree: first.path,
      });
      const occ = retireOrphanedWorktree(main, 9, first.path!, 'work/pr9', undefined, []);
      assert.match(occ ?? '', /agent w1 live/);
      assert.ok(existsSync(first.path!));
      // the owner exits — the same tree is now orphaned residue. A live
      // pid reads 'running' before 'stopped' is consulted, so the exit
      // must move the pid too (a real `agents down` kills the process)
      patchAgentRegistry(main, 'bead-1', { stopped: true, pid: DEAD_PID });
      const gone = retireOrphanedWorktree(main, 9, first.path!, 'work/pr9', undefined, []);
      assert.equal(gone, undefined);
      assert.equal(existsSync(first.path!), false);
      const again = retireOrphanedWorktree(main, 9, first.path!, 'work/pr9', undefined, []);
      assert.equal(again, undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a claimed tree is never retired', () => {
    const { root, main } = initRepo('rig-fixwt2-');
    try {
      git(['checkout', '-qb', 'work/pr10'], main);
      git(['checkout', '-q', 'main'], main);
      const ensured = ensureFixerWorktree(main, 'work/pr10');
      assert.ok(ensured.path !== undefined);
      const gd = worktreeGitDir(ensured.path!)!;
      mkdirSync(join(gd, 'bro'), { recursive: true });
      writeFileSync(join(gd, 'bro', 'work'), `${Date.now()}\nsession-claim\n`);
      const occ = retireOrphanedWorktree(main, 10, ensured.path!, 'work/pr10', undefined, []);
      assert.match(occ ?? '', /claimed by session-claim/);
      assert.ok(existsSync(ensured.path!));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// --- fixer bead + attempt bookkeeping -----------------------------------------

describe('fixer bead plane', () => {
  test('fixerRef/fixerPrFromRef round-trip; fixerBeadFor finds the open row', () => {
    assert.equal(fixerPrFromRef(fixerRef(42)), 42);
    assert.equal(fixerPrFromRef('drive:pr:x'), undefined);
    assert.equal(fixerPrFromRef(undefined), undefined);
    const rows: TaskRow[] = [
      { id: 'f1', external_ref: 'drive:pr:42', status: 'open', labels: [FIXER_LABEL] } as TaskRow,
      { id: 'f2', external_ref: 'drive:pr:43', status: 'closed', labels: [FIXER_LABEL] } as TaskRow,
    ];
    let created = 0;
    const store = {
      list: () => rows,
      create: (input: { externalRef?: string }) => {
        created += 1;
        return { id: 'f-new', external_ref: input.externalRef, status: 'open' } as TaskRow;
      },
    } as unknown as TaskStore;
    assert.equal(fixerBeadFor(store, 42)?.id, 'f1');
    assert.equal(fixerBeadFor(store, 43), undefined); // closed rows don't match
    const bead = ensureFixerBead(store, 44, 'https://x/pull/44', 'work/b');
    assert.equal(bead.id, 'f-new');
    assert.equal(created, 1);
    // the open row wins on a second ensure — no duplicate bead
    const again = ensureFixerBead(store, 42, 'https://x/pull/42', 'work/a');
    assert.equal(again.id, 'f1');
    assert.equal(created, 1);
  });

  test('fixerAttemptSpent/recordFixerAttempt: ok promotes spent; crash stays respawn-able', () => {
    const { main } = initRepo('rig-att-');
    try {
      // the attempt stamp merges over a REAL entry — readAgentRegistry
      // drops rows with no agentId/backend as torn writes
      patchAgentRegistry(main, 'bead-f', {
        agentId: 'fixer-1',
        backend: 'native',
        spawnedAt: new Date().toISOString(),
      });
      const prev = readAgentRegistry(main)['bead-f'];
      recordFixerAttempt(main, 'bead-f', prev, 'head1', 'rebase');
      let entry = readAgentRegistry(main)['bead-f'];
      assert.deepEqual(entry?.fixerAttempt, { head: 'head1', spent: [], current: 'rebase' });
      // the run exits ok → next spawn on same head promotes 'rebase' to spent
      entry = { ...entry!, cause: 'ok' } as AgentRegistryEntry;
      assert.equal(fixerAttemptSpent(entry, 'head1', 'rebase'), true);
      // a different head resets the record
      assert.equal(fixerAttemptSpent(entry, 'head2', 'rebase'), false);
      recordFixerAttempt(main, 'bead-f', entry, 'head2', 'ci');
      const next = readAgentRegistry(main)['bead-f'];
      assert.deepEqual(next?.fixerAttempt, { head: 'head2', spent: [], current: 'ci' });
      // stopped lifts the dedup — the operator's manual clear
      const stopped = { ...next!, stopped: true } as AgentRegistryEntry;
      assert.equal(fixerAttemptSpent(stopped, 'head2', 'ci'), false);
    } finally {
      rmSync(join(main, '..'), { recursive: true, force: true });
    }
  });
});

// --- lock scope -----------------------------------------------------------------

describe('acquireOccupancyLocks — registry → claim order', () => {
  test('holds both locks and releases in reverse; a missing claim lock still holds registry', () => {
    const { root, main } = initRepo('rig-locks-');
    try {
      const wt = join(root, 'wt');
      git(['-C', main, 'worktree', 'add', wt, '-b', 'work/l'], root);
      const release = acquireOccupancyLocks(main, wt);
      release();
      const release2 = acquireOccupancyLocks(main, undefined);
      release2();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
