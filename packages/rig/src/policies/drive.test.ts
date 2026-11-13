/** `drivePolicy` tests — the lifecycle verbs over injected deps,
 *  no CLI imports, no `process.exit` (bro-u6fp5.2). Moved from
 *  `commands/drive.test.ts`: the fixer work-order builders and
 *  `fetchBaseTip` are policy surface now, and the pass/gate/park/lost
 *  describes drive `drivePolicy` through a scripted `DriveDeps` —
 *  the same seam `loopPolicy`'s tests set (bro-u6fp5.1). */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { PrActState } from '@broject/act';
import type {
  AgentInfo,
  CheckInfo,
  ClaimRow,
  PrMeta,
  ReviewFacade,
  ReviewThread,
  TaskRow,
  TaskStore,
} from '@broject/core';
import { LEARN_RETRO_CLOSEOUT } from '@broject/loop';
import {
  buildCiFixerPrompt,
  buildFixerPrompt,
  buildRebaseFixerPrompt,
  buildSastFixerPrompt,
  type BaseTip,
  drivePolicy,
  fetchBaseTip,
  freshDrivePass,
  type DriveCtx,
  type DriveDeps,
  type DriveSpawnRequest,
} from './drive.ts';

// --- real-git fixture (fetchBaseTip) -------------------------------------------
// The cli suite's testrepo helpers can't cross the package boundary —
// the same three primitives, local to this file: a git child with the
// ambient repo/config env scrubbed, an initRepo'd `main` checkout, and
// the chdir-and-clean wrapper.

const AMBIENT_GIT =
  /^(GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_COMMON_DIR|GIT_CONFIG($|_)|GIT_TEMPLATE_DIR$)/;

function gitEnv(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !AMBIENT_GIT.test(k))
  ) as NodeJS.ProcessEnv;
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = devNull;
  return env;
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8' }); // NOSONAR — PATH lookup is the contract (same as core/git.ts)
}

function initRepo(prefix: string): { root: string; main: string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const main = join(root, 'main');
  git(['init', '-q', '-b', 'main', main], root);
  git(['config', 'user.email', 't@t'], main);
  git(['config', 'user.name', 't'], main);
  git(['add', '-A'], main);
  git(['commit', '-qm', 'init', '--allow-empty'], main);
  return { root, main };
}

function inside<T>(dir: string, root: string, fn: () => T): T {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(prev);
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

describe('buildFixerPrompt', () => {
  test('carries the PR link, branch, worktree, threads, and the no-merge rule', () => {
    const p = buildFixerPrompt({
      pr: 42,
      link: '[#42](https://github.com/o/r/pull/42)',
      branch: 'work/bro-a',
      worktree: '/repos/bro--bro-a',
      threads: [
        { path: 'src/x.ts', line: 10, author: 'greptile', body: 'unchecked null' },
        { path: 'src/y.ts', line: 5, author: 'cubic', body: 'drop the cast' },
      ],
    });
    assert.match(p, /#42.*pull\/42/);
    assert.match(p, /work\/bro-a/);
    assert.match(p, /bro--bro-a/);
    assert.match(p, /src\/x\.ts:10 \[greptile\] unchecked null/);
    assert.match(p, /NEVER merge/);
  });
});

describe('buildRebaseFixerPrompt', () => {
  const remoteTip = (sha = 'abc1234'): BaseTip => ({
    ref: 'origin/main',
    sha,
    remote: true,
    origin: true,
  });

  test('carries the PR link, branch, base, worktree, and the no-merge rule', () => {
    const p = buildRebaseFixerPrompt({
      pr: 42,
      link: '[#42](https://github.com/o/r/pull/42)',
      branch: 'work/bro-a',
      base: 'main',
      baseTip: remoteTip(),
      worktree: '/repos/bro--bro-a',
      repo: 'o/r',
      host: 'github',
    });
    assert.match(p, /#42.*pull\/42/);
    assert.match(p, /work\/bro-a/);
    assert.match(p, /bro--bro-a/);
    assert.match(p, /merge conflicts with its base branch `main`/);
    // the work order fetches the PR branch too — a stale local tip would
    // rebase without the remote's newer commits and drop them on push
    assert.match(p, /fetch origin work\/bro-a/);
    assert.match(p, /rebase origin\/work\/bro-a/);
    assert.match(p, /git rebase origin\/main/);
    assert.match(p, /--force-with-lease/);
    assert.match(p, /NEVER merge/);
  });

  test('names the fetched base tip and orders the work fetch → verify → re-check → rebase', () => {
    // bro-by8d3: the base tip bro fetched is the target, and the fixer
    // must notice the base moving under it instead of rebasing blind
    const p = buildRebaseFixerPrompt({
      pr: 42,
      link: '[#42](https://github.com/o/r/pull/42)',
      branch: 'work/bro-a',
      base: 'main',
      baseTip: remoteTip(),
      worktree: '/repos/bro--bro-a',
      repo: 'o/r',
      host: 'github',
    });
    assert.match(p, /abc1234/);
    assert.match(p, /must still read `abc1234`/);
    assert.match(p, /Fetch the base AGAIN, immediately before the rebase/);
    assert.match(p, /gh pr view\s+42 --json mergeable/);
    assert.match(p, /MERGEABLE means the conflict dissolved — STOP/);
    // the fetch lands BEFORE the rebase in the order of work
    assert.ok(p.indexOf('Fetch the base AGAIN') < p.indexOf('git rebase origin/main'));
  });

  test('a gitlab reviews connector gets the glab api read — never gh', () => {
    // the fixer must be able to RUN the re-check it is told to run
    const p = buildRebaseFixerPrompt({
      pr: 42,
      link: '[!42](https://gitlab.example/o/r/-/merge_requests/42)',
      branch: 'work/bro-a',
      base: 'main',
      baseTip: remoteTip(),
      worktree: '/repos/bro--bro-a',
      repo: 'o/r',
      host: 'gitlab',
    });
    assert.match(p, /glab api projects\/o%2Fr\/merge_requests\/42/);
    assert.match(p, /detailed_merge_status/);
    assert.doesNotMatch(p, /gh pr view/);
  });

  test('a LOCAL base is rebase-able: no remote fetch, no invented remote ref', () => {
    // the base lives only locally — the work order must not send the
    // fixer after a remote ref that does not exist
    const p = buildRebaseFixerPrompt({
      pr: 42,
      link: '[#42](https://github.com/o/r/pull/42)',
      branch: 'work/bro-a',
      base: 'main',
      baseTip: { ref: 'main', sha: 'abc1234', remote: false, origin: false },
      worktree: '/repos/bro--bro-a',
      repo: 'o/r',
      host: 'github',
    });
    assert.match(p, /resolved the base to `main`/);
    assert.match(p, /git rebase main/);
    assert.match(p, /This base is a LOCAL branch/);
    assert.doesNotMatch(p, /git rebase origin\/main/);
    // no remote at all — there is nothing to fetch, and the order says so
    assert.doesNotMatch(p, /git fetch origin/);
  });
});

describe('fetchBaseTip', () => {
  test('fetches the base and reads its tip — a stale tracking ref is refreshed', () => {
    const { root, main } = initRepo('bro-drive-base-');
    inside(main, root, () => {
      git(['init', '-q', '--bare', join(root, 'origin.git')], root);
      git(['remote', 'add', 'origin', join(root, 'origin.git')], main);
      git(['push', '-qu', 'origin', 'main'], main);
      // the remote advances; the local tracking ref stays behind
      git(['commit', '-qm', 'remote', '--allow-empty'], main);
      git(['push', '-q', 'origin', 'main'], main);
      const tip = git(['-C', main, 'rev-parse', 'HEAD'], main).trim();
      git(['update-ref', '-d', 'refs/remotes/origin/main'], main);

      const r = fetchBaseTip(main, 'main');
      assert.equal(r.tip?.sha, tip);
      assert.equal(r.tip?.ref, 'origin/main');
      assert.equal(r.tip?.remote, true);
      assert.equal(r.err, undefined);
      assert.equal(git(['-C', main, 'rev-parse', 'origin/main'], main).trim(), tip);
    });
  });

  test('a repo with no origin remote resolves the LOCAL base', () => {
    const { root, main } = initRepo('bro-drive-basen-');
    inside(main, root, () => {
      const r = fetchBaseTip(main, 'main');
      assert.equal(r.tip?.ref, 'main');
      assert.equal(r.tip?.remote, false);
      assert.equal(r.tip?.origin, false);
      assert.equal(r.err, undefined);
    });
  });

  test('a base that exists nowhere is an error — the spawn is refused', () => {
    const { root, main } = initRepo('bro-drive-basex-');
    inside(main, root, () => {
      git(['init', '-q', '--bare', join(root, 'origin.git')], root);
      git(['remote', 'add', 'origin', join(root, 'origin.git')], main);
      const r = fetchBaseTip(main, 'nope');
      assert.equal(r.tip, undefined);
      assert.match(r.err ?? '', /no branch or remote-tracking ref named nope/);
    });
  });

  test('a broken remote is an error — not a silently skipped base', () => {
    const { root, main } = initRepo('bro-drive-baseb-');
    inside(main, root, () => {
      git(['remote', 'add', 'origin', join(root, 'nope.git')], main);
      const r = fetchBaseTip(main, 'main');
      assert.equal(r.tip, undefined);
      assert.ok((r.err ?? '').length > 0);
    });
  });
});
describe('buildCiFixerPrompt', () => {
  test('names the failing checks, the log/annotation reads, and the verdict contract', () => {
    const p = buildCiFixerPrompt({
      pr: 42,
      link: '[#42](https://github.com/o/r/pull/42)',
      branch: 'work/bro-a',
      worktree: '/repos/bro--bro-a',
      repo: 'o/r',
      host: 'github',
      failing: [
        { name: 'build-test', state: 'FAILURE', bucket: 'fail' },
        { name: 'sonarcloud', state: 'FAILURE', bucket: 'fail' },
      ],
    });
    assert.match(p, /#42.*pull\/42/);
    assert.match(p, /work\/bro-a/);
    assert.match(p, /bro--bro-a/);
    assert.match(p, /2 failing check\(s\)/);
    assert.match(p, /- build-test/);
    // a SAST-named run is told apart — its findings are annotations
    assert.match(p, /- sonarcloud — a SAST check.*annotations, not log lines/);
    assert.match(p, /gh run view --log-failed/);
    assert.match(p, /gh api repos\/o\/r\/check-runs\/<run-id>\/annotations/);
    assert.match(p, /NEVER merge/);
    // the no-push exit contract — a clean exit is terminal for the head
    assert.match(p, /clean exit without a push marks this head as attempted/);
    // the other classes' markers must not collide with this work order
    assert.doesNotMatch(p, /unresolved review thread/);
    assert.doesNotMatch(p, /merge conflicts with its base branch/);
  });

  test('a cancelled run is flagged', () => {
    const p = buildCiFixerPrompt({
      pr: 1,
      link: 'x',
      branch: 'b',
      worktree: 'w',
      repo: 'o/r',
      host: 'github',
      failing: [{ name: 'lint', state: 'CANCELLED', bucket: 'cancel' }],
    });
    assert.match(p, /- lint \(cancelled\)/);
  });

  test('a gitlab reviews connector gets glab api commands — never gh', () => {
    const p = buildCiFixerPrompt({
      pr: 42,
      link: '[!42](https://gitlab.example/o/r/-/merge_requests/42)',
      branch: 'work/bro-a',
      worktree: '/repos/bro--bro-a',
      repo: 'o/r',
      host: 'gitlab',
      failing: [
        { name: 'build-test', state: 'failed', bucket: 'fail' },
        { name: 'sonarcloud', state: 'failed', bucket: 'fail' },
      ],
    });
    assert.match(p, /glab api projects\/o%2Fr\/merge_requests\/42\/pipelines/);
    assert.match(p, /glab api projects\/o%2Fr\/pipelines\/<pipeline-id>\/jobs/);
    assert.match(p, /glab api projects\/o%2Fr\/jobs\/<job-id>\/trace/);
    // no annotations endpoint on gitlab — a SAST job's findings are its report
    assert.match(p, /- sonarcloud — a SAST check.*scanner's report/);
    assert.doesNotMatch(p, /gh pr checks|gh run view|check-runs/);
  });
});

describe('buildSastFixerPrompt', () => {
  test('names checks + counts, points at the annotations API, and keeps the contract', () => {
    const p = buildSastFixerPrompt({
      pr: 42,
      link: '[#42](https://github.com/o/r/pull/42)',
      branch: 'work/bro-a',
      worktree: '/repos/bro--bro-a',
      repo: 'o/r',
      host: 'github',
      headSha: 'abc123',
      findings: [
        { name: 'sonarcloud', count: 4 },
        { name: 'codacy', count: null },
      ],
    });
    assert.match(p, /#42.*pull\/42/);
    assert.match(p, /- sonarcloud: 4 finding\(s\)/);
    assert.match(p, /- codacy: annotations unreadable/);
    // the gate counts annotations, not conclusions — the prompt teaches it
    assert.match(p, /GREEN check can/);
    assert.match(p, /gh api repos\/o\/r\/commits\/abc123\/check-runs/);
    assert.match(p, /gh api repos\/o\/r\/check-runs\/<run-id>\/annotations/);
    assert.match(p, /NEVER merge/);
    assert.match(p, /clean exit without a push marks this head as attempted/);
  });

  test('a gitlab reviews connector points at the scanner report — no gh api', () => {
    const p = buildSastFixerPrompt({
      pr: 42,
      link: '[!42](https://gitlab.example/o/r/-/merge_requests/42)',
      branch: 'work/bro-a',
      worktree: '/repos/bro--bro-a',
      repo: 'o/r',
      host: 'gitlab',
      headSha: 'abc123',
      findings: [{ name: 'sonarcloud', count: 2 }],
    });
    assert.match(p, /glab api projects\/o%2Fr/);
    assert.match(p, /no check-run/);
    assert.doesNotMatch(p, /gh api|check-runs\//);
  });
});

describe('fixer work orders — learn+retro closeout (bro-xkv42.1)', () => {
  test('every fixer prompt ends with the shared closeout contract', () => {
    const orders = [
      buildFixerPrompt({
        pr: 42,
        link: 'x',
        branch: 'b',
        worktree: 'w',
        threads: [{ path: 'a.ts', line: 1, author: 'bot', body: 'nit' }],
      }),
      buildRebaseFixerPrompt({
        pr: 42,
        link: 'x',
        branch: 'b',
        base: 'main',
        baseTip: { ref: 'origin/main', sha: 'abc', remote: true, origin: true },
        worktree: 'w',
        repo: 'o/r',
        host: 'github',
      }),
      buildCiFixerPrompt({
        pr: 42,
        link: 'x',
        branch: 'b',
        worktree: 'w',
        repo: 'o/r',
        host: 'github',
        failing: [{ name: 'build', state: 'FAILURE', bucket: 'fail' }],
      }),
      buildSastFixerPrompt({
        pr: 42,
        link: 'x',
        branch: 'b',
        worktree: 'w',
        repo: 'o/r',
        host: 'github',
        headSha: 'abc',
        findings: [{ name: 'sonar', count: 1 }],
      }),
    ];
    for (const p of orders) {
      assert.ok(p.includes(LEARN_RETRO_CLOSEOUT), 'closeout verbatim');
      assert.ok(p.trimEnd().endsWith(LEARN_RETRO_CLOSEOUT), 'closeout is the last word');
    }
  });
});

// --- the FSM over a scripted DriveDeps ----------------------------------------

const NOW = Date.parse('2026-11-20T12:00:00Z');

const openMeta = (over: Partial<PrMeta> = {}): PrMeta => ({
  state: 'OPEN',
  isDraft: false,
  url: 'https://github.com/o/r/pull/7',
  headSha: 'h1',
  headRef: 'work/x',
  baseRef: 'main',
  mergeable: 'MERGEABLE',
  mergeState: 'CLEAN',
  ...over,
});

const settledMeta = (over: Partial<PrMeta> = {}): PrMeta => openMeta({ state: 'MERGED', ...over });

interface World {
  ctx: DriveCtx;
  root: string;
  said: string[];
  errored: string[];
  jsonRows: unknown[];
  alerts: { pr: number; link: string; cause: string; detail?: string }[];
  foreignPush: { pr: number; link: string; head: string | undefined }[];
  merges: number[];
  mergeOk: boolean;
  retires: { state: PrActState; worktree: string | undefined }[];
  settles: { worktree?: string; molSteps?: string[] }[];
  spawned: DriveSpawnRequest[];
  laneUsage: number;
  lanePause: number;
  litter: number;
  projector: number;
  pipeline: number;
  closed: { id: string; reason: string }[];
  rows: TaskRow[];
  prMetaCalls: number;
  /** prMeta's script — shifted per call, last repeats; an Error entry
   *  throws (the probe-failed path). */
  metaQueue: (PrMeta | Error)[];
  prsByBranch: Record<string, number[]>;
  candidates: { branches: string[]; complete: boolean };
  worktreeList: { branch?: string; path: string }[] | null;
  threads: ReviewThread[];
  checks: CheckInfo[];
}

function world(ctxOver: Partial<DriveCtx> = {}, depOver: Partial<DriveDeps> = {}): World {
  const root = mkdtempSync(join(tmpdir(), 'bro-drive-policy-'));
  const said: string[] = [];
  const errored: string[] = [];
  const jsonRows: unknown[] = [];
  const alerts: World['alerts'] = [];
  const foreignPush: World['foreignPush'] = [];
  const merges: number[] = [];
  const retires: World['retires'] = [];
  const settles: World['settles'] = [];
  const spawned: DriveSpawnRequest[] = [];
  const closed: World['closed'] = [];
  const rows: TaskRow[] = [];
  const w: World = {
    // attached below — the dep closures read this same object, so
    // tests mutate w.* and the policy sees it (never a spread copy)
    ctx: undefined as unknown as DriveCtx,
    root,
    said,
    errored,
    jsonRows,
    alerts,
    foreignPush,
    merges,
    mergeOk: true,
    retires,
    settles,
    spawned,
    laneUsage: 0,
    lanePause: 0,
    litter: 0,
    projector: 0,
    pipeline: 0,
    closed,
    rows,
    prMetaCalls: 0,
    metaQueue: [openMeta(), settledMeta()],
    prsByBranch: {},
    candidates: { branches: [], complete: true },
    worktreeList: null,
    threads: [],
    checks: [],
  };
  const rev = {
    prLink: (_repo: string, pr: number) => `[#${pr}](https://github.com/o/r/pull/${pr})`,
    prMeta: (_t: unknown) => {
      w.prMetaCalls += 1;
      const next = w.metaQueue.length > 1 ? w.metaQueue.shift() : w.metaQueue[0];
      if (next instanceof Error) {
        throw next;
      }
      return next;
    },
    reviewThreads: () => w.threads,
    checks: () => w.checks,
    reviewedShas: () => [],
    prsForBranch: (branch: string) => w.prsByBranch[branch] ?? [],
    labels: () => [],
    createLabel: () => {},
    addLabel: () => {},
    removeLabel: () => {},
    prBody: () => '',
    updatePrBody: () => {},
    checkAnnotations: () => [],
  } as unknown as ReviewFacade;
  const store = {
    list: () => rows,
    get: (id: string) => rows.find(r => r.id === id),
    close: (id: string, reason: string) => {
      closed.push({ id, reason });
    },
    create: () => {
      throw new Error('unexpected store.create in a policy test');
    },
  } as unknown as TaskStore;
  const deps: DriveDeps = {
    rev,
    store,
    stateCache: null,
    say: m => said.push(m),
    error: m => errored.push(m),
    emitJson: row => {
      jsonRows.push(row);
    },
    now: () => NOW,
    sleepMs: async () => {},
    mergePr: async pr => {
      merges.push(pr);
      return w.mergeOk;
    },
    retireLanding: (state, worktree) => {
      retires.push({ state, worktree });
    },
    settleSessions: opts => {
      settles.push(opts);
    },
    shadowNotes: async () => undefined,
    isAcpProvider: () => false,
    connectorAcceptsWorkers: () => true,
    spawnAgent: async req => {
      spawned.push(req);
      return { id: 'fixer-agent', pid: 4242 } as AgentInfo;
    },
    candidateBranches: () => w.candidates,
    worktrees: () => w.worktreeList,
    collectAgents: async () => ({ byStep: new Map<string, AgentInfo>(), degraded: [] }),
    judgeBudget: () => ({ remaining: 5 }),
    laneUsage: async () => {
      w.laneUsage += 1;
    },
    lanePause: () => {
      w.lanePause += 1;
    },
    litterSweep: async () => {
      w.litter += 1;
    },
    publishAlert: async (pr, link, cause, detail) => {
      alerts.push({ pr, link, cause, detail });
    },
    signalForeignPush: async (pr, link, head) => {
      foreignPush.push({ pr, link, head });
    },
    projectorTick: () => {
      w.projector += 1;
    },
    armProjectorFeed: async () => {},
    pipelineWake: async () => {
      w.pipeline += 1;
      return { locked: false, runs: [] };
    },
    ...depOver,
  };
  const ctx: DriveCtx = {
    deps,
    mainRoot: root,
    host: 'github',
    repo: 'o/r',
    act: {
      ignoreChecks: [],
      maxRounds: 3,
      docsPaths: [],
      docsMaxRounds: 1,
      requireApproval: false,
      approvers: [],
    },
    merge: true,
    json: true,
    occTtlMs: 7_200_000,
    litter: { sweepSec: 0, lastAt: 0 },
    work: freshDrivePass(),
    ...ctxOver,
  };
  w.ctx = ctx;
  return w;
}

describe('drivePolicy.select — the pass pick', () => {
  test('dequeues the open set in enumeration order, then drains', () => {
    const w = world();
    w.ctx.work.pending = [3, 1, 2];
    assert.equal(drivePolicy.select(w.ctx), 3);
    assert.equal(drivePolicy.select(w.ctx), 1);
    assert.equal(drivePolicy.select(w.ctx), 2);
    assert.equal(drivePolicy.select(w.ctx), undefined);
  });

  test('an empty pass selects nothing', () => {
    const w = world();
    assert.equal(drivePolicy.select(w.ctx), undefined);
  });
});

describe('drivePolicy.onPark — the human-alert settle', () => {
  test('publishes the alert keyed per PR+cause and returns nothing', async () => {
    const w = world();
    const v = await drivePolicy.onPark(w.ctx, 7, 'blocked', 'merge conflicts');
    assert.equal(v, undefined);
    assert.deepEqual(w.alerts, [
      {
        pr: 7,
        link: '[#7](https://github.com/o/r/pull/7)',
        cause: 'blocked',
        detail: 'merge conflicts',
      },
    ]);
  });
});

describe('drivePolicy.onGate — the gate verdict', () => {
  test('a probe failure is the alert-worthy probe-failed verdict', async () => {
    const w = world();
    w.metaQueue = [new Error('host unreachable')];
    w.ctx.work.pending = [7];
    const v = await drivePolicy.onGate(w.ctx, 7);
    assert.equal(v.pr, 7);
    assert.equal(v.verdict, 'probe-failed');
    assert.match(v.detail ?? '', /host unreachable/);
  });

  test('a settled PR closes its fixer bead and reports settled', async () => {
    const w = world();
    w.metaQueue = [settledMeta({ state: 'CLOSED' })];
    w.rows.push({
      id: 'fixer-1',
      status: 'in_progress',
      external_ref: 'drive:pr:7',
      labels: ['fixer'],
    });
    // closeFixer emits lifecycle events under process.cwd() — park the
    // cwd on the non-repo fixture root so the emit no-ops (same guard
    // the cli suite's inside() gives its fixtures)
    const prev = process.cwd();
    process.chdir(w.root);
    try {
      const v = await drivePolicy.onGate(w.ctx, 7);
      assert.equal(v.verdict, 'settled');
      assert.equal(v.detail, 'closed');
    } finally {
      process.chdir(prev);
    }
    assert.deepEqual(w.closed, [
      { id: 'fixer-1', reason: '[#7](https://github.com/o/r/pull/7) closed — fixer done' },
    ]);
    // the head the pass acted on rides the pass work for the
    // foreign-push signal
    assert.equal(w.ctx.work.heads.get(7), 'h1');
  });

  test('a green orphaned PR merges, re-probes, retires, and reports merged', async () => {
    const w = world();
    const wt = join(w.root, 'wt-x');
    mkdirSync(wt);
    w.worktreeList = [{ branch: 'work/x', path: wt }];
    w.candidates = { branches: ['work/x'], complete: true };
    w.prsByBranch = { 'work/x': [7] };
    await drivePolicy.pass(w.ctx);
    assert.equal(w.merges.length, 1);
    assert.equal(w.merges[0], 7);
    // the post-merge re-probe (uncached) read MERGED — retirement ran
    assert.equal(w.retires.length, 1);
    assert.equal(w.retires[0]?.worktree, wt);
    assert.equal(w.retires[0]?.state.state, 'MERGED');
    assert.deepEqual(w.settles, [{ worktree: wt }]);
    const row = w.jsonRows[0] as { verdict?: string; pr?: number };
    assert.equal(row?.pr, 7);
    assert.equal(row?.verdict, 'merged');
    // the foreign-push signal saw the head the pass acted on
    assert.deepEqual(w.foreignPush, [
      { pr: 7, link: '[#7](https://github.com/o/r/pull/7)', head: 'h1' },
    ]);
    // pass ticks all fired exactly once
    assert.equal(w.laneUsage, 1);
    assert.equal(w.lanePause, 1);
    assert.equal(w.projector, 1);
    assert.equal(w.pipeline, 1);
  });
});

describe('drivePolicy.onLost — the settled-fixer sweep', () => {
  const fixerRow = (id: string, pr: number, status = 'in_progress'): TaskRow => ({
    id,
    status,
    external_ref: `drive:pr:${pr}`,
    labels: ['fixer'],
  });

  test('a fixer bead whose PR settled is probed, settled, and closed', async () => {
    const w = world();
    w.metaQueue = [settledMeta()];
    w.rows.push(fixerRow('fixer-1', 7));
    const prev = process.cwd();
    process.chdir(w.root);
    try {
      await drivePolicy.sweepFixers(w.ctx);
    } finally {
      process.chdir(prev);
    }
    assert.equal(w.prMetaCalls, 1);
    assert.deepEqual(w.settles, [{ molSteps: ['fixer-1'] }]);
    assert.deepEqual(w.closed, [
      {
        id: 'fixer-1',
        reason: '[#7](https://github.com/o/r/pull/7) merged — fixer done',
      },
    ]);
    assert.ok(w.said.some(s => s.includes('settled (merged) — fixer fixer-1 closed')));
  });

  test('a fixer bead whose PR is still open is left alone', async () => {
    const w = world();
    w.ctx.work.prs = new Set([7]);
    w.rows.push(fixerRow('fixer-1', 7));
    await drivePolicy.sweepFixers(w.ctx);
    assert.equal(w.prMetaCalls, 0);
    assert.equal(w.closed.length, 0);
  });

  test('closed rows and non-drive refs never reach the probe', async () => {
    const w = world();
    w.rows.push(fixerRow('fixer-1', 7, 'closed'));
    w.rows.push({ id: 'other', status: 'in_progress', external_ref: 'drive:pr:x' });
    w.rows.push({ id: 'plain', status: 'in_progress' });
    await drivePolicy.sweepFixers(w.ctx);
    assert.equal(w.prMetaCalls, 0);
    assert.equal(w.closed.length, 0);
  });

  test('a probe failure warns and keeps the bead for the next pass', async () => {
    const w = world();
    w.metaQueue = [new Error('host down')];
    w.rows.push(fixerRow('fixer-1', 7));
    await drivePolicy.sweepFixers(w.ctx);
    assert.equal(w.prMetaCalls, 1);
    assert.equal(w.closed.length, 0);
    assert.ok(w.said.some(s => s.includes('fixer sweep probe failed')));
  });
});

describe('drivePolicy.pass — the enumeration+service sweep', () => {
  test('an empty fleet reports and still runs every pass tick', async () => {
    const w = world();
    await drivePolicy.pass(w.ctx);
    assert.ok(w.said.includes('drive: no open PRs on fleet branches'));
    assert.equal(w.laneUsage, 1);
    assert.equal(w.lanePause, 1);
    assert.equal(w.projector, 1);
    assert.equal(w.pipeline, 1);
    assert.equal(w.jsonRows.length, 0);
  });

  test('the litter sweep rides its cadence — sweepSec 0 skips it', async () => {
    const w = world();
    w.ctx.litter = { sweepSec: 0, lastAt: 0 };
    await drivePolicy.pass(w.ctx);
    assert.equal(w.litter, 0);
    const w2 = world();
    w2.ctx.litter = { sweepSec: 1, lastAt: 0 };
    await drivePolicy.pass(w2.ctx);
    assert.equal(w2.litter, 1);
    // lastAt advanced — an immediate second pass stays under cadence
    await drivePolicy.pass(w2.ctx);
    assert.equal(w2.litter, 1);
  });

  test('a throwing probe isolates to its PR — the pass continues and alerts', async () => {
    const w = world();
    // PR 7's probe throws; PR 9 reads OPEN then the merge re-probe
    // reads MERGED — the queue's last entry repeats
    w.metaQueue = [new Error('gh exploded'), openMeta({ headRef: 'work/y' }), settledMeta()];
    w.candidates = { branches: ['work/x', 'work/y'], complete: true };
    w.prsByBranch = { 'work/x': [7], 'work/y': [9] };
    w.worktreeList = [
      { branch: 'work/x', path: join(w.root, 'wt-x') },
      { branch: 'work/y', path: join(w.root, 'wt-y') },
    ];
    mkdirSync(join(w.root, 'wt-x'));
    mkdirSync(join(w.root, 'wt-y'));
    await drivePolicy.pass(w.ctx);
    // PR 7 probe-failed → alert + verdict row; PR 9 green → merged
    assert.deepEqual(
      w.alerts.map(a => `${a.pr}:${a.cause}`),
      ['7:probe-failed']
    );
    const verdicts = w.jsonRows.map(r => (r as { verdict?: string }).verdict);
    assert.deepEqual(verdicts, ['probe-failed', 'merged']);
    assert.deepEqual(w.merges, [9]);
  });

  // the claims rung (bro-izpyk.10): one list per pass, snapshot-fed to
  // every occupancy read; a live claim on the PR's tree is the same
  // veto a fresh marker is
  const claimRow = (over: Partial<ClaimRow> = {}): ClaimRow => ({
    resource: 'worktree:/repo/main',
    host: 'devin',
    sid: 'sess-keeper',
    project: null,
    exclusive: false,
    leaseUntil: Date.now() + 60_000,
    claimedAt: Date.now() - 5_000,
    ttlMs: 60_000,
    ...over,
  });

  test('a live ledger claim on the PR tree green-occupies — fetched once per pass', async () => {
    const w = world();
    const wt = join(w.root, 'wt-x');
    mkdirSync(wt);
    let calls = 0;
    w.ctx.deps.claims = async () => {
      calls += 1;
      return [claimRow({ resource: `worktree:${wt}` })];
    };
    w.candidates = { branches: ['work/x'], complete: true };
    w.prsByBranch = { 'work/x': [7] };
    w.worktreeList = [{ branch: 'work/x', path: wt }];
    w.metaQueue = [openMeta()]; // green — the claim is the only veto
    await drivePolicy.pass(w.ctx);
    assert.equal(calls, 1, 'the pass must list claims exactly once');
    const verdicts = w.jsonRows.map(r => (r as { verdict?: string }).verdict);
    assert.deepEqual(verdicts, ['green-occupied']);
    assert.deepEqual(w.merges, []);
  });

  test('a throwing claims list degrades to the marker plane — the pass still merges', async () => {
    const w = world();
    w.ctx.deps.claims = async () => {
      throw new Error('ledger gone');
    };
    w.candidates = { branches: ['work/x'], complete: true };
    w.prsByBranch = { 'work/x': [7] };
    // probe → OPEN; merge re-probe → MERGED (the merge-unverified tail
    // repeats the last entry, so the queue needs the settled row)
    w.metaQueue = [openMeta(), settledMeta()];
    await drivePolicy.pass(w.ctx);
    const verdicts = w.jsonRows.map(r => (r as { verdict?: string }).verdict);
    assert.deepEqual(verdicts, ['merged']);
    assert.deepEqual(w.merges, [7]);
  });
});
