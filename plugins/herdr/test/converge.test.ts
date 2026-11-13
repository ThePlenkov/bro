import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FAKE_HERDR = join(HERE, 'fixtures', 'fake-herdr');
chmodSync(FAKE_HERDR, 0o755);

// module-scope env BEFORE the plugin modules load — lib.ts binds
// HERDR_BIN_PATH / HERDR_PLUGIN_STATE_DIR as consts at import time.
const TMP = mkdtempSync(join(tmpdir(), 'bro-herdr-converge-'));
const LOG = join(TMP, 'herdr-calls.log');
const SCENARIO = join(TMP, 'scenario.json');
process.env.HERDR_BIN_PATH = FAKE_HERDR;
process.env.HERDR_PLUGIN_STATE_DIR = join(TMP, 'state');
process.env.FAKE_HERDR_LOG = LOG;
process.env.FAKE_HERDR_SCENARIO = SCENARIO;
// production binds PLUGIN_ROOT to the plugin dir — same pin here so
// the session pane's tui/main.ts probe sees the real entrypoint
process.env.HERDR_PLUGIN_ROOT = join(HERE, '..');
// the session pane's bun probe is machine-dependent — pin the
// line-mode fallback so the command assertions hold everywhere
process.env.BUN_BIN_PATH = '';

const { converge, ensureSyncLoop } = await import('../src/reconcile.ts');
const { loadState, PLUGIN_ROOT, gitTop, saveState, stateScope, syncPidPath } = await import(
  '../src/lib.ts'
);
const { ensureSession, retireSession, sessionCommand } = await import('../src/sessions.ts');
const { procStat } = await import('../../../packages/core/src/index.ts');
type Planes = import('../src/planes.ts').Planes;

const MAIN = join(TMP, 'main');
mkdirSync(MAIN, { recursive: true });
// MAIN is a real repo — the viewable gate reads session records out of
// its git common dir, so tests can seed binds under .git/bro
spawnSync('git', ['init', '-q', MAIN]);
const scope = stateScope(MAIN);

const calls = (): string[][] =>
  existsSync(LOG)
    ? readFileSync(LOG, 'utf8')
        .split('\n')
        .filter(l => l !== '')
        .map(l => JSON.parse(l) as string[])
    : [];

const called = (...prefix: string[]): string[][] =>
  calls().filter(a => prefix.every((p, i) => a[i] === p));

const reset = (scenario: Record<string, unknown> = {}): void => {
  rmSync(LOG, { force: true });
  rmSync(join(TMP, 'state'), { recursive: true, force: true });
  rmSync(`${SCENARIO}.state`, { force: true });
  // the seeded registry dies with each scenario — a bind must never
  // leak into the next test's viewable gate
  rmSync(join(MAIN, '.git', 'bro'), { recursive: true, force: true });
  writeFileSync(SCENARIO, JSON.stringify(scenario));
};

const planes = (over: Partial<Planes> = {}): Planes => ({
  repo: MAIN,
  main: MAIN,
  status: {
    dir: MAIN,
    worktrees: [],
    beads: { inProgress: [] },
    fleet: { maxConcurrent: 4, agents: [] },
    loop: { stallMin: 30, runs: [] },
  },
  worktrees: { source: { source_checkout_path: MAIN }, worktrees: [] },
  workspaces: [],
  registry: {},
  armedDetails: [],
  mirrorPanes: {},
  rendererPanes: {},
  statusPanes: {},
  sessionPanes: {},
  lanes: {},
  ...over,
});

const armedTree = (dir: string, claim = 'bead-1'): Planes =>
  planes({
    status: {
      dir: MAIN,
      worktrees: [{ name: 't', path: dir, claim }],
      beads: { inProgress: [{ id: claim, title: 'Ship it' }] },
      fleet: { maxConcurrent: 4, agents: [] },
      loop: { stallMin: 30, runs: [] },
    },
  });

/** An armed tree whose projector verdict is the acp lane (spec
 *  bro-l8wqu) — the session pane is its one human pane. */
const armedAcpTree = (dir: string, claim = 'bead-1'): Planes => {
  const p = armedTree(dir, claim);
  p.lanes = { [dir]: 'acp' };
  return p;
};

/** A dead session record binding the tree — the viewable gate's
 *  archive source: a registry entry under MAIN's git dir plus its
 *  journal file (archiveBinds only binds what existsSync can see). */
const seedBind = (tree: string): void => {
  const broDir = join(MAIN, '.git', 'bro');
  mkdirSync(join(broDir, 'agents'), { recursive: true });
  const log = join(broDir, 'agents', 'run-1.log');
  writeFileSync(join(broDir, 'agents', 'run-1.events.jsonl'), '{}\n');
  writeFileSync(
    join(broDir, 'agents.json'),
    JSON.stringify({ 'run-1': { log, worktree: tree, spawnedAt: 'x' } })
  );
};

/** An armed tree WITH a session record — the viewable gate's minimum:
 *  workspaces open only where a session pane has something to show. */
const boundTree = (dir: string, claim = 'bead-1'): Planes => {
  seedBind(dir);
  return armedTree(dir, claim);
};

/** A LIVE agent on the tree whose journal has not landed yet — a
 *  warming run: registry entry with a live pid, no events file. */
const seedWarming = (tree: string): void => {
  const broDir = join(MAIN, '.git', 'bro');
  const reg = JSON.parse(readFileSync(join(broDir, 'agents.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  reg['run-2'] = {
    log: join(broDir, 'agents', 'run-2.log'),
    worktree: tree,
    pid: process.pid,
  };
  writeFileSync(join(broDir, 'agents.json'), JSON.stringify(reg));
};

const H = 3_600_000;

describe('dead-workspace reaper', () => {
  const DEAD = join(TMP, 'gone-tree');

  const deadPlanes = (): Planes =>
    planes({
      worktrees: {
        source: { source_checkout_path: MAIN },
        worktrees: [{ path: DEAD, open_workspace_id: 'wDead' }],
      },
      workspaces: [{ workspace_id: 'wDead', label: 'orphan' }],
    });

  test('first missing sighting stamps goneSince — no close', () => {
    reset();
    converge(deadPlanes());
    assert.equal(typeof loadState(scope).gone[DEAD], 'number');
    assert.equal(called('workspace', 'close').length, 0);
  });

  test('second sighting past the grace window closes the workspace', () => {
    reset();
    const s = loadState(scope);
    s.gone[DEAD] = Date.now() - 90_000;
    s.statuses[DEAD] = { workspace: 'wDead', worktree: DEAD, pane_id: 'pDead' };
    saveState(scope, s);
    converge(deadPlanes());
    assert.deepEqual(called('workspace', 'close', 'wDead').length, 1);
    const st = loadState(scope);
    assert.equal(st.gone[DEAD], undefined);
    assert.equal(st.workspaces[DEAD], undefined);
    assert.equal(st.statuses[DEAD], undefined);
  });

  test('a reappearing path clears the stamp — transient misses reap nothing', () => {
    reset();
    const live = mkdtempSync(join(TMP, 'back-'));
    const s = loadState(scope);
    s.gone[live] = Date.now() - 90_000;
    saveState(scope, s);
    converge(
      planes({
        worktrees: {
          source: { source_checkout_path: MAIN },
          worktrees: [{ path: live, open_workspace_id: 'wBack' }],
        },
        workspaces: [{ workspace_id: 'wBack', label: 'back' }],
      })
    );
    assert.equal(loadState(scope).gone[live], undefined);
    assert.equal(called('workspace', 'close').length, 0);
  });
});

describe('the viewable gate — no session content, no window', () => {
  test('an armed tree with nothing recorded opens no workspace', () => {
    reset({ panes: [{ pane_id: 'p1' }] });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    // claim armed, lane null, zero session records — an empty window
    // is never worth a human's screen (user ruling 10.11)
    converge(armedTree(tree));
    assert.equal(called('worktree', 'open').length, 0);
    assert.equal(called('pane', 'run').length, 0);
    assert.equal(loadState(scope).workspaces[tree], undefined);
    assert.equal(loadState(scope).sessions[tree], undefined);
  });

  test('a managed workspace losing all session content closes whole', () => {
    reset({ panes: [{ pane_id: 'p1' }] });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    converge(boundTree(tree));
    assert.equal(loadState(scope).workspaces[tree]?.ws, 'wOpened');
    // the record dies — the tree stays armed but the window has
    // nothing left to show: close it, drop every record
    rmSync(join(MAIN, '.git', 'bro'), { recursive: true, force: true });
    const p = armedTree(tree);
    p.worktrees.worktrees = [{ path: tree, open_workspace_id: 'wOpened' }];
    p.workspaces = [{ workspace_id: 'wOpened', label: '⚙️ t' }];
    converge(p);
    assert.equal(called('workspace', 'close', 'wOpened').length, 1);
    const st = loadState(scope);
    assert.equal(st.workspaces[tree], undefined);
    assert.equal(st.sessions[tree], undefined);
  });

  test('a foreign workspace on an unviewable tree is left alone', () => {
    reset({ panes: [{ pane_id: 'pUser' }] });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    const p = armedTree(tree);
    p.worktrees.worktrees = [{ path: tree, open_workspace_id: 'wUser' }];
    p.workspaces = [{ workspace_id: 'wUser', label: 'theirs' }];
    // managed === false means hands off — even for an empty window
    const s = loadState(scope);
    s.workspaces[tree] = { ws: 'wUser', label: 'theirs', managed: false };
    saveState(scope, s);
    converge(p);
    assert.equal(called('workspace', 'close').length, 0);
    assert.equal(loadState(scope).workspaces[tree]?.ws, 'wUser');
  });
});

describe('renderer panes', () => {
  test('managed workspace gets the session pane — the ONE human pane', () => {
    reset({ panes: [{ pane_id: 'p1' }] });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    converge(boundTree(tree));
    // every managed tree arms the session view — a record-less tree
    // renders its honest empty state; the technical panes are plugin
    // plumbing that never takes the user's screen
    const runs = called('pane', 'run');
    assert.equal(runs.length, 1);
    assert.equal(runs[0]![2], 'p1');
    assert.match(runs[0]![3]!, /herdr session-view/);
    assert.deepEqual(called('pane', 'rename', 'p1', 'bro: session').length, 1);
    assert.equal(loadState(scope).sessions[tree]?.pane_id, 'p1');
    assert.equal(loadState(scope).renderers[tree], undefined);
    assert.equal(loadState(scope).statuses[tree], undefined);
  });

  test('busy panes split instead of stealing the foreground', () => {
    reset({ panes: [{ pane_id: 'p1' }], busyPanes: ['p1'] });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    converge(boundTree(tree));
    // the session pane splits off the busy pane — exactly one pane
    assert.equal(called('pane', 'split', 'p1').length, 1);
    const runs = called('pane', 'run');
    assert.equal(runs.length, 1);
    assert.match(runs[0]![2]!, /^pSplit/);
    assert.match(runs[0]![3]!, /herdr session-view/);
  });

  test('a tech-labeled orphan folds under the session pane, not adopted', () => {
    reset({
      panes: [{ pane_id: 'pTail', label: 'bro: events' }, { pane_id: 'pX' }],
      paneIds: ['pTail', 'pX'],
    });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    const s = loadState(scope);
    s.renderers[tree] = { workspace: 'wOpened', worktree: tree, pane_id: 'pTail' };
    saveState(scope, s);
    converge(boundTree(tree));
    // the events tail is plumbing — the session pane folds it away
    // and takes the free pane
    assert.equal(called('pane', 'close', 'pTail').length, 1);
    assert.equal(loadState(scope).renderers[tree], undefined);
    assert.equal(loadState(scope).sessions[tree]?.pane_id, 'pX');
  });

  test('a live mirror folds under the session pane like the tail does', () => {
    reset({
      panes: [{ pane_id: 'pTail' }, { pane_id: 'pMirror' }, { pane_id: 'pX' }],
      paneIds: ['pTail', 'pMirror', 'pX'],
    });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    // a live agent keeps the mirror unmarked — markExitedMirrors runs first
    const p = boundTree(tree);
    p.status.fleet.agents = [
      {
        id: 'step-1',
        backend: 'native',
        state: 'running',
        worktree: 't',
        log: join(TMP, 'x.log'),
      },
    ];
    const s = loadState(scope);
    s.mirrors['step-1'] = {
      step: 'step-1',
      log: join(TMP, 'x.log'),
      worktree: tree,
      workspace: 'wOpened',
      pane_id: 'pMirror',
    };
    s.renderers[tree] = { workspace: 'wOpened', worktree: tree, pane_id: 'pTail' };
    saveState(scope, s);
    converge(p);
    // both technical surfaces fold — the session pane is the one pane
    assert.equal(called('pane', 'close', 'pTail').length, 1);
    assert.equal(called('pane', 'close', 'pMirror').length, 1);
    assert.equal(loadState(scope).renderers[tree], undefined);
    assert.equal(loadState(scope).mirrors['step-1'], undefined);
    assert.equal(loadState(scope).sessions[tree]?.pane_id, 'pX');
  });

  test('an exited (marked) mirror stays an exit marker beside the session pane', () => {
    reset({ panes: [{ pane_id: 'pMirror' }, { pane_id: 'pX' }], paneIds: ['pMirror', 'pX'] });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    const s = loadState(scope);
    s.mirrors['step-1'] = {
      step: 'step-1',
      log: join(TMP, 'x.log'),
      worktree: tree,
      workspace: 'wOpened',
      pane_id: 'pMirror',
      marked: true,
    };
    saveState(scope, s);
    converge(boundTree(tree));
    // the dead mirror is an exit marker the session view renders —
    // the session pane arms as the one pane, no tech fallback
    const runs = called('pane', 'run');
    assert.equal(runs.length, 1);
    assert.match(runs[0]![3]!, /herdr session-view/);
    assert.equal(loadState(scope).renderers[tree], undefined);
    assert.equal(loadState(scope).statuses[tree], undefined);
    assert.equal(loadState(scope).sessions[tree]?.pane_id, 'pX');
  });

  test('a dead session view on a live pane re-arms in place', () => {
    reset({ panes: [{ pane_id: 'p1' }], paneIds: ['p1'] });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    const s = loadState(scope);
    s.sessions[tree] = {
      workspace: 'wOpened',
      worktree: tree,
      pane_id: 'p1',
      agent_id: 'run-1',
    };
    saveState(scope, s);
    converge(boundTree(tree));
    const runs = called('pane', 'run');
    assert.equal(runs.length, 1);
    assert.equal(runs[0]![2], 'p1');
    assert.match(runs[0]![3]!, /herdr session-view/);
    assert.equal(loadState(scope).sessions[tree]?.pane_id, 'p1');
  });

  test('a recorded pane still running the session view is left alone', () => {
    reset({ panes: [{ pane_id: 'p1' }], paneIds: ['p1'], busyPanes: ['p1'] });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    const s = loadState(scope);
    s.sessions[tree] = {
      workspace: 'wOpened',
      worktree: tree,
      pane_id: 'p1',
      agent_id: 'run-1',
    };
    saveState(scope, s);
    converge(boundTree(tree));
    // a live session pane is untouched — and no tech pane appears
    assert.equal(called('pane', 'run').length, 0);
    assert.equal(loadState(scope).sessions[tree]?.pane_id, 'p1');
  });

  test('a stale managed record cannot pane a user-reopened workspace', () => {
    reset({ panes: [{ pane_id: 'pUser' }] });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    const p = boundTree(tree);
    p.worktrees.worktrees = [{ path: tree, open_workspace_id: 'wUser' }];
    p.workspaces = [{ workspace_id: 'wUser', label: 'their label' }];
    const s = loadState(scope);
    s.workspaces[tree] = { ws: 'wOld', label: '[silent1h] old', managed: true };
    saveState(scope, s);
    converge(p);
    assert.equal(called('pane', 'run').length, 0);
    assert.equal(called('pane', 'split').length, 0);
    assert.equal(loadState(scope).renderers[tree], undefined);
    assert.equal(loadState(scope).statuses[tree], undefined);
  });

  test('a user-opened workspace gets no panes, no tokens, no rename', () => {
    reset({ panes: [{ pane_id: 'p1' }] });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    const p = boundTree(tree);
    p.worktrees.worktrees = [{ path: tree, open_workspace_id: 'wUser' }];
    p.workspaces = [{ workspace_id: 'wUser', label: 'their label' }];
    converge(p);
    assert.equal(called('pane', 'run').length, 0);
    assert.equal(called('pane', 'split').length, 0);
    assert.equal(called('workspace', 'rename').length, 0);
    assert.equal(called('workspace', 'report-metadata').length, 0);
  });
});

describe('status + events panes — plugin plumbing, folded everywhere', () => {
  test('the tech panes never arm — the session pane is the one pane', () => {
    reset({ panes: [{ pane_id: 'p1' }, { pane_id: 'p2' }] });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    converge(boundTree(tree));
    // one pane only, and it is the session view — no bus tail, no
    // status strip: a record-less tree renders its empty state there
    const runs = called('pane', 'run');
    assert.equal(runs.length, 1);
    assert.match(runs[0]![3]!, /herdr session-view/);
    assert.equal(
      called('pane', 'run').filter(r => /bus subscribe|status-view/.test(r[3] ?? '')).length,
      0
    );
    assert.equal(loadState(scope).statuses[tree], undefined);
    assert.equal(loadState(scope).renderers[tree], undefined);
  });

  test('recorded status + events panes fold when the session pane arms', () => {
    reset({
      panes: [{ pane_id: 'pS' }, { pane_id: 'pE' }, { pane_id: 'pX' }],
      paneIds: ['pS', 'pE', 'pX'],
    });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    const s = loadState(scope);
    s.statuses[tree] = { workspace: 'wOpened', worktree: tree, pane_id: 'pS' };
    s.renderers[tree] = { workspace: 'wOpened', worktree: tree, pane_id: 'pE' };
    saveState(scope, s);
    converge(boundTree(tree));
    assert.equal(called('pane', 'close', 'pS').length, 1);
    assert.equal(called('pane', 'close', 'pE').length, 1);
    const st = loadState(scope);
    assert.equal(st.statuses[tree], undefined);
    assert.equal(st.renderers[tree], undefined);
    assert.equal(st.sessions[tree]?.pane_id, 'pX');
  });

  test('a stale record pointing at a closed workspace is dropped', () => {
    reset({ panes: [{ pane_id: 'pLive' }] });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    const p = boundTree(tree);
    p.worktrees.worktrees = [{ path: tree, open_workspace_id: 'wLive' }];
    p.workspaces = [{ workspace_id: 'wLive', label: 'live' }];
    const s = loadState(scope);
    // the live workspace is ours — a managed record keeps the status
    // converge aimed at it
    s.workspaces[tree] = { ws: 'wLive', label: 'live', managed: true };
    // recorded under a DIFFERENT tree bound to a workspace that no
    // longer exists — the orphan drop must not resurrect it
    s.statuses[join(TMP, 'old-tree')] = {
      workspace: 'wGone',
      worktree: join(TMP, 'old-tree'),
      pane_id: 'pOld',
    };
    saveState(scope, s);
    converge(p);
    const st = loadState(scope);
    assert.equal(st.statuses[join(TMP, 'old-tree')], undefined);
    // and the live workspace got its session pane — the one pane
    assert.ok(st.sessions[tree]?.pane_id !== undefined);
    assert.equal(st.statuses[tree], undefined);
  });
});

describe('session panes — the acp lane’s one pane (spec bro-nwl5g → bro-l8wqu)', () => {
  test('a spare idle pane becomes the session view — and the ONLY pane', () => {
    reset({ panes: [{ pane_id: 'p1' }, { pane_id: 'p2' }, { pane_id: 'p3' }] });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    converge(armedAcpTree(tree));
    // one human-readable pane: session takes the first idle pane,
    // events + status never arm on the acp lane
    assert.deepEqual(called('pane', 'rename', 'p1', 'bro: session').length, 1);
    const runs = called('pane', 'run', 'p1');
    assert.equal(runs.length, 1);
    assert.match(runs[0]![3]!, /herdr session-view/);
    assert.match(runs[0]![3]!, new RegExp(tree.replace(/[\\/.]/g, '\\$&')));
    assert.equal(called('pane', 'run').length, 1);
    assert.equal(loadState(scope).sessions[tree]?.pane_id, 'p1');
    assert.equal(loadState(scope).statuses[tree], undefined);
    assert.equal(loadState(scope).renderers[tree], undefined);
  });

  test('a recorded live session pane is left alone', () => {
    reset({ panes: [{ pane_id: 'pV' }], paneIds: ['pV'], busyPanes: ['pV'] });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    const s = loadState(scope);
    s.sessions[tree] = { workspace: 'wOpened', worktree: tree, pane_id: 'pV' };
    saveState(scope, s);
    converge(armedAcpTree(tree));
    assert.ok(called('pane', 'run', 'pV').length === 0);
    assert.equal(loadState(scope).sessions[tree]?.pane_id, 'pV');
  });

  test('a dead session view on a live pane re-arms in place', () => {
    reset({ panes: [{ pane_id: 'pV' }], paneIds: ['pV'] });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    const s = loadState(scope);
    s.sessions[tree] = { workspace: 'wOpened', worktree: tree, pane_id: 'pV' };
    saveState(scope, s);
    converge(armedAcpTree(tree));
    const runs = called('pane', 'run', 'pV');
    assert.equal(runs.length, 1);
    assert.match(runs[0]![3]!, /herdr session-view/);
    assert.equal(loadState(scope).sessions[tree]?.pane_id, 'pV');
  });

  test('a session-labeled orphan is adopted — events and status never arm', () => {
    reset({ panes: [{ pane_id: 'pOrph', label: 'bro: session' }], paneIds: ['pOrph'] });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    converge(armedAcpTree(tree));
    const runs = called('pane', 'run', 'pOrph');
    assert.equal(runs.length, 1);
    assert.match(runs[0]![3]!, /herdr session-view/);
    assert.equal(loadState(scope).sessions[tree]?.pane_id, 'pOrph');
    // the acp lane is session-only — no split for the other roles
    assert.equal(called('pane', 'split').length, 0);
    assert.equal(loadState(scope).statuses[tree], undefined);
    assert.equal(loadState(scope).renderers[tree], undefined);
  });

  test('a lane flip to acp retires the status + events panes', () => {
    reset({
      panes: [{ pane_id: 'pS' }, { pane_id: 'pE' }, { pane_id: 'pRoot' }],
      paneIds: ['pS', 'pE', 'pRoot'],
    });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    const s = loadState(scope);
    s.statuses[tree] = { workspace: 'wOpened', worktree: tree, pane_id: 'pS' };
    s.renderers[tree] = { workspace: 'wOpened', worktree: tree, pane_id: 'pE' };
    saveState(scope, s);
    converge(armedAcpTree(tree));
    assert.equal(called('pane', 'close', 'pS').length, 1);
    assert.equal(called('pane', 'close', 'pE').length, 1);
    const st = loadState(scope);
    assert.equal(st.statuses[tree], undefined);
    assert.equal(st.renderers[tree], undefined);
    // and the session pane armed in their place — the workspace's
    // surviving root pane is the free slot
    assert.equal(called('pane', 'run').length, 1);
    const run = called('pane', 'run')[0]!;
    assert.equal(run[2], 'pRoot');
    assert.match(run[3]!, /herdr session-view/);
  });

  test('an archived (dead) session record still arms the session pane', () => {
    reset({ panes: [{ pane_id: 'p1' }] });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    const repoMain = mkdtempSync(join(TMP, 'repo-'));
    spawnSync('git', ['init', '-q', repoMain]);
    const broDir = join(repoMain, '.git', 'bro');
    mkdirSync(broDir, { recursive: true });
    // dead registry record — no live pid, journal on disk: 'done' is
    // a status row in the view, not a reason to hide the pane
    writeFileSync(join(repoMain, 'native-1.events.jsonl'), '{}\n');
    writeFileSync(
      join(broDir, 'agents.json'),
      JSON.stringify({
        'run-1': { log: join(repoMain, 'native-1.log'), worktree: tree, spawnedAt: 'x' },
      })
    );
    const p = boundTree(tree);
    p.repo = repoMain;
    p.main = repoMain;
    p.status.dir = repoMain;
    converge(p);
    // the ONE human pane arms bound to the archive — events + status
    // fold into it, nothing else splits
    const runs = called('pane', 'run');
    assert.equal(runs.length, 1);
    assert.match(runs[0]![3]!, /herdr session-view/);
    assert.match(runs[0]![3]!, /--events .*native-1\.events\.jsonl/);
    const st = loadState(stateScope(repoMain));
    assert.equal(st.sessions[tree]?.pane_id, 'p1');
    assert.equal(st.renderers[tree], undefined);
    assert.equal(st.statuses[tree], undefined);
  });

  test('a warming live agent without a journal keeps the archive bind', () => {
    reset({ panes: [{ pane_id: 'p1' }] });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    const p = boundTree(tree);
    // run-2 is alive (pid pinned) but its events file never landed —
    // it must not bury run-1's readable archive (codeant thread)
    seedWarming(tree);
    converge(p);
    const runs = called('pane', 'run');
    assert.equal(runs.length, 1);
    assert.match(runs[0]![3]!, /--events .*run-1\.events\.jsonl/);
    assert.equal(loadState(scope).sessions[tree]?.agent_id, 'run-1');
  });

  test('a lane flip OFF acp keeps the session pane — the view, not the lane', () => {
    reset({
      panes: [{ pane_id: 'pV', label: 'bro: session' }, { pane_id: 'pX' }],
      paneIds: ['pV', 'pX'],
    });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    const s = loadState(scope);
    s.sessions[tree] = {
      workspace: 'wOpened',
      worktree: tree,
      pane_id: 'pV',
      agent_id: 'run-1',
    };
    saveState(scope, s);
    converge(boundTree(tree));
    // losing the acp lane never folds the human pane — the view is
    // armed on every managed tree now; no tech pane appears either
    assert.equal(called('pane', 'close', 'pV').length, 0);
    const st = loadState(scope);
    assert.equal(st.sessions[tree]?.pane_id, 'pV');
    assert.equal(st.renderers[tree], undefined);
    assert.equal(st.statuses[tree], undefined);
  });

  test('a live native agent gets no mirror — the lane yields exactly one pane', () => {
    reset({ panes: [{ pane_id: 'p1' }] });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    const p = armedAcpTree(tree);
    p.status.fleet.agents = [
      {
        id: 'step-1',
        backend: 'native',
        state: 'running',
        worktree: 't',
        log: join(TMP, 'x.log'),
      },
    ];
    converge(p);
    // dogfood finding: convergeMirrors armed `bro: step-1` beside
    // `bro: session` — the mirror folds like status/events did
    const runs = called('pane', 'run');
    assert.equal(runs.length, 1);
    assert.match(runs[0]![3]!, /herdr session-view/);
    assert.equal(called('pane', 'split').length, 0);
    assert.equal(loadState(scope).mirrors['step-1'], undefined);
  });

  test('a lane flip to acp retires the live worker’s mirror too', () => {
    reset({
      panes: [{ pane_id: 'pM', label: 'bro: step-1' }, { pane_id: 'pRoot' }],
      paneIds: ['pM', 'pRoot'],
    });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    const p = armedAcpTree(tree);
    p.status.fleet.agents = [
      {
        id: 'step-1',
        backend: 'native',
        state: 'running',
        worktree: 't',
        log: join(TMP, 'x.log'),
      },
    ];
    const s = loadState(scope);
    s.mirrors['step-1'] = {
      step: 'step-1',
      log: join(TMP, 'x.log'),
      worktree: tree,
      workspace: 'wOpened',
      pane_id: 'pM',
    };
    saveState(scope, s);
    converge(p);
    assert.equal(called('pane', 'close', 'pM').length, 1);
    const st = loadState(scope);
    assert.equal(st.mirrors['step-1'], undefined);
    // the session pane takes the surviving root — one run, one pane
    const runs = called('pane', 'run');
    assert.equal(runs.length, 1);
    assert.equal(runs[0]![2], 'pRoot');
    assert.match(runs[0]![3]!, /herdr session-view/);
  });

  test('an exited worker’s mirror retires on the acp lane — no ✖ marker pane', () => {
    reset({
      panes: [{ pane_id: 'pM', label: 'bro: step-1' }],
      paneIds: ['pM'],
    });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    const s = loadState(scope);
    s.mirrors['step-1'] = {
      step: 'step-1',
      log: join(TMP, 'x.log'),
      worktree: tree,
      workspace: 'wOpened',
      pane_id: 'pM',
    };
    saveState(scope, s);
    // no agent in the fleet — step-1 is exited; the acp lane retires
    // its mirror outright instead of renaming it an exit marker
    converge(armedAcpTree(tree));
    assert.equal(called('pane', 'close', 'pM').length, 1);
    assert.equal(called('pane', 'rename', 'pM').length, 0);
    assert.equal(loadState(scope).mirrors['step-1'], undefined);
  });

  test('a fallback workspace flips to acp in one pass — the session pane arms before the last pane retires', () => {
    reset({
      panes: [
        { pane_id: 'pM', label: 'bro: step-1' },
        { pane_id: 'pE', label: 'bro: events' },
        { pane_id: 'pS', label: 'bro: status' },
      ],
      paneIds: ['pM', 'pE', 'pS'],
      busyPanes: ['pM', 'pE', 'pS'],
    });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    const p = armedAcpTree(tree);
    p.status.fleet.agents = [
      {
        id: 'step-1',
        backend: 'native',
        state: 'running',
        worktree: 't',
        log: join(TMP, 'x.log'),
      },
    ];
    const s = loadState(scope);
    s.mirrors['step-1'] = {
      step: 'step-1',
      log: join(TMP, 'x.log'),
      worktree: tree,
      workspace: 'wOpened',
      pane_id: 'pM',
    };
    s.renderers[tree] = { workspace: 'wOpened', worktree: tree, pane_id: 'pE' };
    s.statuses[tree] = { workspace: 'wOpened', worktree: tree, pane_id: 'pS' };
    saveState(scope, s);
    converge(p);
    // the ordering IS the contract: a workspace losing its last pane is
    // auto-reaped, so the session pane must be armed before ANY retire
    // lands — the fake cannot model the reap, the call order can
    const log = calls();
    const runIdx = log.findIndex(
      a => a[0] === 'pane' && a[1] === 'run' && /session-view/.test(a[3] ?? '')
    );
    const closes = log.filter(a => a[0] === 'pane' && a[1] === 'close');
    assert.ok(runIdx !== -1, 'session pane armed');
    assert.equal(closes.length, 3);
    for (const [i, c] of log.entries()) {
      if (c[0] === 'pane' && c[1] === 'close') {
        assert.ok(runIdx < i, `close ${c[2]} landed before the session arm`);
      }
    }
    // one pass → exactly one pane left standing: the session view
    const st = loadState(scope);
    assert.equal(st.mirrors['step-1'], undefined);
    assert.equal(st.renderers[tree], undefined);
    assert.equal(st.statuses[tree], undefined);
    assert.ok(st.sessions[tree]?.pane_id !== undefined);
    assert.equal(called('pane', 'run').length, 1);
  });

  test('a stale session record on a closed workspace is dropped', () => {
    reset({ panes: [{ pane_id: 'pLive' }] });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    const p = armedAcpTree(tree);
    p.worktrees.worktrees = [{ path: tree, open_workspace_id: 'wLive' }];
    p.workspaces = [{ workspace_id: 'wLive', label: 'live' }];
    const s = loadState(scope);
    s.workspaces[tree] = { ws: 'wLive', label: 'live', managed: true };
    s.sessions[join(TMP, 'old-tree')] = {
      workspace: 'wGone',
      worktree: join(TMP, 'old-tree'),
      pane_id: 'pOld',
    };
    saveState(scope, s);
    converge(p);
    const st = loadState(scope);
    assert.equal(st.sessions[join(TMP, 'old-tree')], undefined);
    assert.ok(st.sessions[tree]?.pane_id !== undefined);
  });

  test('the reaper clears session records with the workspace', () => {
    const DEAD = join(TMP, 'gone-tree');
    reset();
    const s = loadState(scope);
    s.gone[DEAD] = Date.now() - 90_000;
    s.sessions[DEAD] = { workspace: 'wDead', worktree: DEAD, pane_id: 'pDead' };
    saveState(scope, s);
    converge(
      planes({
        worktrees: {
          source: { source_checkout_path: MAIN },
          worktrees: [{ path: DEAD, open_workspace_id: 'wDead' }],
        },
        workspaces: [{ workspace_id: 'wDead', label: 'orphan' }],
      })
    );
    assert.equal(loadState(scope).sessions[DEAD], undefined);
  });
});

describe('workspace labels — lifecycle only (spec bro-u19mq)', () => {
  test('open carries the plain title — status prefixes are the daemon projector', () => {
    reset();
    const tree = mkdtempSync(join(TMP, 'tree-'));
    const p = boundTree(tree);
    p.status.worktrees[0]!.branch = 'work/bead-1';
    p.status.loop.runs = [
      { beadId: 'bead-1', slug: 'bead-1', state: 'running', worktree: tree, silentMs: 16.5 * H },
    ];
    converge(p);
    const opens = called('worktree', 'open');
    assert.equal(opens.length, 1);
    const label = opens[0]![opens[0]!.indexOf('--label') + 1]!;
    assert.equal(label, `⚙️ ${basename(tree)}`);
  });

  test('an acp-lane workspace opens with the robot marker (spec bro-l8wqu)', () => {
    reset();
    const tree = mkdtempSync(join(TMP, 'tree-'));
    converge(armedAcpTree(tree));
    const opens = called('worktree', 'open');
    assert.equal(opens.length, 1);
    const label = opens[0]![opens[0]!.indexOf('--label') + 1]!;
    assert.equal(label, `🤖 ${basename(tree)}`);
  });

  test('the plugin never renames or tokens a managed workspace', () => {
    reset();
    const tree = mkdtempSync(join(TMP, 'tree-'));
    const p = boundTree(tree);
    p.worktrees.worktrees = [{ path: tree, open_workspace_id: 'w1' }];
    p.workspaces = [{ workspace_id: 'w1', label: 'Ship it' }];
    // ours on record, but renames/status tokens belong to the daemon
    const s = loadState(scope);
    s.workspaces[tree] = { ws: 'w1', label: 'Ship it', managed: true };
    saveState(scope, s);
    p.status.loop.runs = [
      { beadId: 'bead-1', slug: 'bead-1', state: 'running', worktree: tree, silentMs: 10 * H },
    ];
    converge(p);
    assert.equal(called('workspace', 'rename').length, 0);
    assert.equal(called('workspace', 'report-metadata').length, 0);
    // the managed record survives — it is how the projector learns ownership
    assert.equal(loadState(scope).workspaces[tree]?.managed, true);
  });

  test('a projector-written label drift is mirrored into the record', () => {
    reset();
    const tree = mkdtempSync(join(TMP, 'tree-'));
    const p = boundTree(tree);
    p.worktrees.worktrees = [{ path: tree, open_workspace_id: 'w1' }];
    p.workspaces = [{ workspace_id: 'w1', label: '[silent10h·#765 2t] Ship it' }];
    const s = loadState(scope);
    s.workspaces[tree] = { ws: 'w1', label: 'Ship it', managed: true };
    saveState(scope, s);
    converge(p);
    assert.equal(called('workspace', 'rename').length, 0);
    assert.equal(loadState(scope).workspaces[tree]?.label, '[silent10h·#765 2t] Ship it');
  });
});

describe('live views — coverage by the session pane', () => {
  test('a relative registry worktree still suppresses the second view', () => {
    reset({ panes: [{ pane_id: 'p1' }] });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    // the registry read goes through gitCommonDir — the repo main
    // must be a REAL repo for the agents.json seed to be visible
    const repoMain = mkdtempSync(join(TMP, 'repo-'));
    spawnSync('git', ['init', '-q', repoMain]);
    const broDir = join(repoMain, '.git', 'bro');
    mkdirSync(broDir, { recursive: true });
    // the registry may carry a RELATIVE worktree — before the
    // normalize-once fix the coverage check compared it against the
    // armed set's absolute paths, never matched, and opened a second
    // 🤖 view: workspace beside the session pane (PR #876 review)
    writeFileSync(
      join(broDir, 'agents.json'),
      JSON.stringify({
        'run-1': {
          log: join(repoMain, 'native-1.log'),
          worktree: relative(repoMain, tree),
          pid: process.pid,
        },
      })
    );
    const p = armedAcpTree(tree);
    p.repo = repoMain;
    p.main = repoMain;
    p.status.dir = repoMain;
    converge(p);
    // the session pane arms bound to the journal directly — the
    // line-mode command carries --events/--agent too
    const runs = called('pane', 'run');
    assert.equal(runs.length, 1);
    assert.match(runs[0]![3]!, /--events .*native-1\.events\.jsonl.* --agent .*native-1/);
    // coverage sees the same absolute path the armed set carries —
    // NO second view workspace beside the session pane
    assert.equal(called('workspace', 'create').length, 0);
    assert.deepEqual(loadState(stateScope(repoMain)).liveViews, {});
  });
});

describe('session panes — rebind backoff', () => {
  test('a failed rebind backs off instead of churning panes each pass', () => {
    reset({
      // two free panes absorb the fallback surfaces a failed rebind no
      // longer suppresses (sessionLive gates them): the renderer and
      // status arms take p2/p3 without splitting, so the split count
      // stays the rebind's own
      panes: [{ pane_id: 'p1' }, { pane_id: 'p2' }, { pane_id: 'p3' }],
      paneIds: ['p1', 'p2', 'p3'],
      failSubcommands: ['pane run'],
    });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    // the registry read goes through gitCommonDir — a REAL repo main
    const repoMain = mkdtempSync(join(TMP, 'repo-'));
    spawnSync('git', ['init', '-q', repoMain]);
    const broDir = join(repoMain, '.git', 'bro');
    mkdirSync(broDir, { recursive: true });
    // a DIFFERENT live agent resolves for the tree → the recorded
    // binding is stale and decideSession asks for a rebind
    writeFileSync(
      join(broDir, 'agents.json'),
      JSON.stringify({
        'run-1': { log: join(repoMain, 'native-B.log'), worktree: tree, pid: process.pid },
      })
    );
    const scope = stateScope(repoMain);
    const s = loadState(scope);
    s.sessions[tree] = {
      workspace: 'wOpened',
      worktree: tree,
      pane_id: 'p1',
      agent_id: 'native-A',
    };
    saveState(scope, s);
    const p = armedAcpTree(tree);
    p.repo = repoMain;
    p.main = repoMain;
    p.status.dir = repoMain;
    converge(p);
    // the arm failed — the stale pane stays, exactly ONE split+close,
    // and the retry is armed for later
    assert.equal(called('pane', 'split').length, 1);
    assert.equal(called('pane', 'close', 'p1').length, 0);
    const st1 = loadState(scope);
    assert.equal(st1.sessions[tree]?.pane_id, 'p1');
    assert.equal(typeof st1.sessions[tree]?.retryAt, 'number');
    // the very next pass hits the backoff — no second split
    converge(p);
    assert.equal(called('pane', 'split').length, 1);
    // the window expired AND the failure cleared — the retry lands:
    // a second split, the stale pane closes, the binding rebinds
    st1.sessions[tree]!.retryAt = 0;
    saveState(scope, st1);
    writeFileSync(SCENARIO, JSON.stringify({ panes: [{ pane_id: 'p1' }], paneIds: ['p1'] }));
    converge(p);
    assert.equal(called('pane', 'split').length, 2);
    assert.equal(called('pane', 'close', 'p1').length, 1);
    const st3 = loadState(scope).sessions[tree];
    assert.equal(st3?.agent_id, 'native-B');
    assert.notEqual(st3?.pane_id, 'p1');
    assert.equal(st3?.retryAt, undefined);
  });
});

describe('sessionCommand — the pane command (spec bro-q2edc)', () => {
  test('BUN_BIN_PATH set → the OpenTUI app runs in the pane', () => {
    process.env.BUN_BIN_PATH = '/opt/bun/bin/bun';
    try {
      const cmd = sessionCommand('/repo/trees/t1');
      assert.match(cmd, /^'\/opt\/bun\/bin\/bun' run '.*tui\/main\.ts'/);
      assert.ok(cmd.endsWith('/repo/trees/t1' + "'"));
    } finally {
      process.env.BUN_BIN_PATH = '';
    }
  });

  test('BUN_BIN_PATH empty → the line-mode session-view fallback', () => {
    process.env.BUN_BIN_PATH = '';
    const cmd = sessionCommand('/repo/trees/t1');
    assert.match(cmd, /herdr session-view '\/repo\/trees\/t1'/);
  });
});

describe('session panes — the pending-close ledger', () => {
  const TREE = join(TMP, 'ledger-tree');

  const seed = (rec: Record<string, unknown>): void => {
    const s = loadState(scope);
    (s.sessions as Record<string, unknown>)[TREE] = {
      workspace: 'wS',
      worktree: TREE,
      ...rec,
    };
    saveState(scope, s);
  };

  test('a recycled pane id drops off the ledger — never closed', () => {
    reset({
      panes: [
        { pane_id: 'pS', label: 'bro: session' },
        { pane_id: 'pUser', label: 'shell' },
      ],
    });
    seed({ pane_id: 'pS', closePending: ['pUser'] });
    // the ctx state is the in-memory record — converge owns the save
    const state = loadState(scope);
    ensureSession({ path: TREE, ws: 'wS', state });
    // the pending id wears a foreign label now — a user took the pane
    assert.equal(called('pane', 'close', 'pUser').length, 0);
    assert.equal(state.sessions[TREE]?.closePending, undefined);
  });

  test('the ledger survives the rebind — armSession carries it forward', () => {
    reset({
      panes: [
        { pane_id: 'pS', label: 'bro: session' },
        { pane_id: 'pOld', label: 'bro: session' },
      ],
      failSubcommands: ['pane close'],
    });
    seed({ pane_id: 'pS', agent_id: 'native-old', closePending: ['pOld'] });
    const state = loadState(scope);
    const ok = ensureSession({
      path: TREE,
      ws: 'wS',
      state,
      agent: { id: 'native-new', events: '/e.jsonl' },
    });
    assert.equal(ok, true);
    // retryClose failed on pOld, the rebind's own close of pS failed
    // too — the fresh record keeps BOTH ids pending for later passes
    assert.deepEqual(state.sessions[TREE]?.closePending, ['pOld', 'pS']);
    assert.notEqual(state.sessions[TREE]?.pane_id, 'pS');
  });

  test('a failed rebind reports false — and the backoff adds no churn', () => {
    reset({
      panes: [{ pane_id: 'pS', label: 'bro: session' }],
      failSubcommands: ['pane run'],
    });
    seed({ pane_id: 'pS', agent_id: 'native-old' });
    const state = loadState(scope);
    const ctx = {
      path: TREE,
      ws: 'wS',
      state,
      agent: { id: 'native-new', events: '/e.jsonl' },
    };
    // the replacement arm failed — the stale pane is bound to the OLD
    // archive, so the pass must not call it the live session pane
    assert.equal(ensureSession(ctx), false);
    assert.equal(typeof state.sessions[TREE]?.retryAt, 'number');
    const splits = called('pane', 'split').length;
    // the very next pass hits the backoff — still not-live, no churn
    assert.equal(ensureSession(ctx), false);
    assert.equal(called('pane', 'split').length, splits);
  });

  test('retireSession drains the ledger before dropping the record', () => {
    reset({
      panes: [
        { pane_id: 'pS', label: 'bro: session' },
        { pane_id: 'pOld', label: 'bro: session' },
        { pane_id: 'pUser', label: 'shell' },
      ],
    });
    seed({ pane_id: 'pS', closePending: ['pOld', 'pUser'] });
    const state = loadState(scope);
    retireSession({ path: TREE, ws: 'wS', state });
    assert.equal(called('pane', 'close', 'pS').length, 1);
    // the ledger's session-labeled id is drained with the record; the
    // recycled one (foreign label) is never ours to kill
    assert.equal(called('pane', 'close', 'pOld').length, 1);
    assert.equal(called('pane', 'close', 'pUser').length, 0);
    assert.equal(state.sessions[TREE], undefined);
  });
});

describe('the sync loop ensure', () => {
  // PLUGIN_ROOT pins the plugin dir, so the ensure's repo resolves to
  // THIS checkout's git top — the pid file lands under TMP/state
  const pidFile = (): string => syncPidPath(stateScope(gitTop(PLUGIN_ROOT) ?? PLUGIN_ROOT));
  // the launcher seam — tests count calls, never fork a real loop
  const stub = (): { calls: number; launch: (scope: string) => boolean } => {
    const s = { calls: 0, launch: (_scope: string): boolean => (s.calls++, true) };
    return s;
  };

  test('a live pinned pid suppresses the spawn', () => {
    reset();
    mkdirSync(dirname(pidFile()), { recursive: true });
    writeFileSync(pidFile(), `${process.pid} ${procStat(process.pid)?.start ?? ''}\n`);
    const s = stub();
    ensureSyncLoop(s.launch);
    assert.equal(s.calls, 0);
  });

  test('a dead loop spawns — pending lands BEFORE the launch', () => {
    reset();
    mkdirSync(dirname(pidFile()), { recursive: true });
    writeFileSync(pidFile(), '99999999 stale-start\n');
    const s = stub();
    ensureSyncLoop(s.launch);
    assert.equal(s.calls, 1);
    // the marker was written before the launch — the stub never
    // writes a pid, so 'pending' is what the file holds
    assert.equal(readFileSync(pidFile(), 'utf8').trim(), 'pending');
  });

  test('a fresh pending marker suppresses a second spawn', () => {
    reset();
    mkdirSync(dirname(pidFile()), { recursive: true });
    writeFileSync(pidFile(), 'pending\n');
    const s = stub();
    ensureSyncLoop(s.launch);
    assert.equal(s.calls, 0);
  });

  test('a stale pending marker is a crashed opener — broken and replaced', () => {
    reset();
    mkdirSync(dirname(pidFile()), { recursive: true });
    writeFileSync(pidFile(), 'pending\n');
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(pidFile(), old, old);
    const s = stub();
    ensureSyncLoop(s.launch);
    assert.equal(s.calls, 1);
  });

  test('a failed spawn keeps a real pid the child already published', () => {
    reset();
    mkdirSync(dirname(pidFile()), { recursive: true });
    // the child spawned anyway and wrote its handle before the parent
    // reported failure — that marker is a live loop's, not residue
    writeFileSync(pidFile(), `${process.pid} ${procStat(process.pid)?.start ?? ''}\n`);
    // the live probe wins before the spawn path is even reached
    const s = stub();
    ensureSyncLoop(s.launch);
    assert.equal(s.calls, 0);
    assert.equal(existsSync(pidFile()), true);
  });

  test('a failed spawn leaves no pending marker behind', () => {
    reset();
    mkdirSync(dirname(pidFile()), { recursive: true });
    writeFileSync(pidFile(), '99999999 stale-start\n');
    const s = stub();
    s.launch = () => (s.calls++, false);
    ensureSyncLoop(s.launch);
    assert.equal(s.calls, 1);
    assert.equal(existsSync(pidFile()), false);
  });

  test('a foreign-owned live pid with its start token still counts as live', (t: TestContext) => {
    const st = procStat(1);
    if (st === null || st.start === '') return t.skip('no /proc to verify identity');
    reset();
    mkdirSync(dirname(pidFile()), { recursive: true });
    writeFileSync(pidFile(), `1 ${st.start}\n`);
    // kill(1,0) is EPERM for an unprivileged run — the shared probe
    // still verifies identity through /proc instead of reading dead
    const s = stub();
    ensureSyncLoop(s.launch);
    assert.equal(s.calls, 0);
  });

  test('the loop never opens a plugin pane — plumbing stays off screen', () => {
    reset();
    mkdirSync(dirname(pidFile()), { recursive: true });
    const s = stub();
    ensureSyncLoop(s.launch);
    assert.equal(called('plugin', 'pane', 'open').length, 0);
  });
});
