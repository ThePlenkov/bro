import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, test } from 'node:test';
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

const { converge } = await import('../src/reconcile.ts');
const { loadState, saveState, stateScope } = await import('../src/lib.ts');
type Planes = import('../src/planes.ts').Planes;

const MAIN = join(TMP, 'main');
mkdirSync(MAIN, { recursive: true });
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

describe('renderer panes', () => {
  test('managed workspace gets one event-tail pane on an idle pane', () => {
    reset({ panes: [{ pane_id: 'p1' }] });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    converge(armedTree(tree));
    const runs = called('pane', 'run');
    assert.equal(runs.length, 3);
    assert.equal(runs[0]![2], 'p1');
    assert.match(runs[0]![3]!, /bus subscribe/);
    assert.match(runs[0]![3]!, /--topic worker/);
    assert.deepEqual(called('pane', 'rename', 'p1', 'bro: events').length, 1);
    assert.equal(loadState(scope).renderers[tree]?.pane_id, 'p1');
    // status + session panes converge in the same pass — p1 is busy
    // now, so each takes a fresh split
    assert.match(runs[1]![3]!, /herdr status-view/);
    assert.equal(loadState(scope).statuses[tree]?.pane_id, runs[1]![2]);
    assert.match(runs[2]![3]!, /herdr session-view/);
    assert.equal(loadState(scope).sessions[tree]?.pane_id, runs[2]![2]);
  });

  test('busy panes split instead of stealing the foreground', () => {
    reset({ panes: [{ pane_id: 'p1' }], busyPanes: ['p1'] });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    converge(armedTree(tree));
    // renderer + status + session splits — all hang off the one busy pane
    assert.equal(called('pane', 'split', 'p1').length, 3);
    const runs = called('pane', 'run');
    assert.equal(runs.length, 3);
    assert.match(runs[0]![2]!, /^pSplit/);
    assert.match(runs[0]![3]!, /bus subscribe/);
    assert.match(runs[1]![3]!, /herdr status-view/);
    assert.match(runs[2]![3]!, /herdr session-view/);
  });

  test('an orphan pane carrying our label is adopted, not duplicated', () => {
    reset({
      panes: [{ pane_id: 'pTail', label: 'bro: events' }],
      paneIds: ['pTail'],
      busyPanes: ['pTail'],
    });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    const s = loadState(scope);
    s.renderers[tree] = { workspace: 'wOpened', worktree: tree, pane_id: 'pGone' };
    saveState(scope, s);
    converge(armedTree(tree));
    // the renderer adopts the orphan; status + session each need their
    // own slot — two splits, off the only live pane
    assert.equal(called('pane', 'split').length, 2);
    assert.equal(loadState(scope).renderers[tree]?.pane_id, 'pTail');
  });

  test('a live mirror retires the fallback tail', () => {
    reset({ panes: [{ pane_id: 'pTail' }], paneIds: ['pTail', 'pMirror'] });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    // a live agent keeps the mirror unmarked — markExitedMirrors runs first
    const p = armedTree(tree);
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
    assert.equal(called('pane', 'close', 'pTail').length, 1);
    assert.equal(loadState(scope).renderers[tree], undefined);
  });

  test('an exited (marked) mirror does not suppress the fallback tail', () => {
    reset({ panes: [{ pane_id: 'pTail' }], paneIds: ['pTail', 'pMirror'] });
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
    converge(armedTree(tree));
    // the dead mirror is an exit marker, not a renderer — the tail
    // arms, and the status + session panes converge beside it
    assert.equal(called('pane', 'run').length, 3);
    assert.equal(loadState(scope).renderers[tree]?.pane_id, 'pTail');
    assert.ok(loadState(scope).statuses[tree]?.pane_id !== undefined);
    assert.ok(loadState(scope).sessions[tree]?.pane_id !== undefined);
  });

  test('a dead tail on a live pane re-arms in place', () => {
    reset({ panes: [{ pane_id: 'p1' }], paneIds: ['p1'] });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    const s = loadState(scope);
    s.renderers[tree] = { workspace: 'wOpened', worktree: tree, pane_id: 'p1' };
    saveState(scope, s);
    converge(armedTree(tree));
    const runs = called('pane', 'run');
    assert.equal(runs.length, 3);
    assert.equal(runs[0]![2], 'p1');
    assert.equal(loadState(scope).renderers[tree]?.pane_id, 'p1');
  });

  test('a recorded pane still running the tail is left alone', () => {
    reset({ panes: [{ pane_id: 'p1' }], paneIds: ['p1'], busyPanes: ['p1'] });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    const s = loadState(scope);
    s.renderers[tree] = { workspace: 'wOpened', worktree: tree, pane_id: 'p1' };
    saveState(scope, s);
    converge(armedTree(tree));
    // the tail is untouched; status + session converge (splits)
    const runs = called('pane', 'run');
    assert.equal(runs.length, 2);
    assert.match(runs[0]![3]!, /herdr status-view/);
    assert.match(runs[1]![3]!, /herdr session-view/);
  });

  test('a stale managed record cannot pane a user-reopened workspace', () => {
    reset({ panes: [{ pane_id: 'pUser' }] });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    const p = armedTree(tree);
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
    const p = armedTree(tree);
    p.worktrees.worktrees = [{ path: tree, open_workspace_id: 'wUser' }];
    p.workspaces = [{ workspace_id: 'wUser', label: 'their label' }];
    converge(p);
    assert.equal(called('pane', 'run').length, 0);
    assert.equal(called('pane', 'split').length, 0);
    assert.equal(called('workspace', 'rename').length, 0);
    assert.equal(called('workspace', 'report-metadata').length, 0);
  });
});

describe('status panes (spec bro-idsat)', () => {
  test('a spare idle pane becomes the status view', () => {
    reset({ panes: [{ pane_id: 'p1' }, { pane_id: 'p2' }] });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    converge(armedTree(tree));
    // renderer takes the first idle pane; the status view takes p2 —
    // a NORMAL pane: rename + pane run, never an overlay
    assert.deepEqual(called('pane', 'rename', 'p2', 'bro: status').length, 1);
    const runs = called('pane', 'run', 'p2');
    assert.equal(runs.length, 1);
    assert.match(runs[0]![3]!, /herdr status-view/);
    assert.match(runs[0]![3]!, new RegExp(tree.replace(/[\\/.]/g, '\\$&')));
    assert.equal(loadState(scope).statuses[tree]?.pane_id, 'p2');
  });

  test('a recorded live status pane is left alone', () => {
    reset({ panes: [{ pane_id: 'pS' }], paneIds: ['pS'], busyPanes: ['pS'] });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    const s = loadState(scope);
    s.statuses[tree] = { workspace: 'wOpened', worktree: tree, pane_id: 'pS' };
    saveState(scope, s);
    converge(armedTree(tree));
    // the renderer still converges (a split), but nothing re-arms pS
    assert.ok(called('pane', 'run', 'pS').length === 0);
    assert.equal(loadState(scope).statuses[tree]?.pane_id, 'pS');
  });

  test('a dead status view on a live pane re-arms in place', () => {
    reset({ panes: [{ pane_id: 'pS' }], paneIds: ['pS'] });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    const s = loadState(scope);
    s.statuses[tree] = { workspace: 'wOpened', worktree: tree, pane_id: 'pS' };
    saveState(scope, s);
    converge(armedTree(tree));
    const runs = called('pane', 'run', 'pS');
    assert.equal(runs.length, 1);
    assert.match(runs[0]![3]!, /herdr status-view/);
    assert.equal(loadState(scope).statuses[tree]?.pane_id, 'pS');
  });

  test('an orphan pane carrying the status label is adopted', () => {
    reset({ panes: [{ pane_id: 'pOrph', label: 'bro: status' }], paneIds: ['pOrph'] });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    converge(armedTree(tree));
    // the only split is the renderer's — the status role never steals
    // a pane for itself while a labeled orphan exists to adopt
    const runs = called('pane', 'run', 'pOrph');
    assert.equal(runs.length, 1);
    assert.match(runs[0]![3]!, /herdr status-view/);
    assert.equal(loadState(scope).statuses[tree]?.pane_id, 'pOrph');
  });

  test('a stale record pointing at a closed workspace is dropped', () => {
    reset({ panes: [{ pane_id: 'pLive' }] });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    const p = armedTree(tree);
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
    // and the live workspace got its own status pane
    assert.ok(st.statuses[tree]?.pane_id !== undefined);
  });
});

describe('session panes (spec bro-nwl5g)', () => {
  test('a spare idle pane becomes the session view', () => {
    reset({ panes: [{ pane_id: 'p1' }, { pane_id: 'p2' }, { pane_id: 'p3' }] });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    converge(armedTree(tree));
    // renderer takes p1, status p2, session p3
    assert.deepEqual(called('pane', 'rename', 'p3', 'bro: session').length, 1);
    const runs = called('pane', 'run', 'p3');
    assert.equal(runs.length, 1);
    assert.match(runs[0]![3]!, /herdr session-view/);
    assert.match(runs[0]![3]!, new RegExp(tree.replace(/[\\/.]/g, '\\$&')));
    assert.equal(loadState(scope).sessions[tree]?.pane_id, 'p3');
  });

  test('a recorded live session pane is left alone', () => {
    reset({ panes: [{ pane_id: 'pV' }], paneIds: ['pV'], busyPanes: ['pV'] });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    const s = loadState(scope);
    s.sessions[tree] = { workspace: 'wOpened', worktree: tree, pane_id: 'pV' };
    saveState(scope, s);
    converge(armedTree(tree));
    assert.ok(called('pane', 'run', 'pV').length === 0);
    assert.equal(loadState(scope).sessions[tree]?.pane_id, 'pV');
  });

  test('a dead session view on a live pane re-arms in place', () => {
    reset({ panes: [{ pane_id: 'pV' }], paneIds: ['pV'] });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    const s = loadState(scope);
    s.sessions[tree] = { workspace: 'wOpened', worktree: tree, pane_id: 'pV' };
    saveState(scope, s);
    converge(armedTree(tree));
    const runs = called('pane', 'run', 'pV');
    assert.equal(runs.length, 1);
    assert.match(runs[0]![3]!, /herdr session-view/);
    assert.equal(loadState(scope).sessions[tree]?.pane_id, 'pV');
  });

  test('a session-labeled orphan is adopted by sessions, never stolen by other roles', () => {
    reset({ panes: [{ pane_id: 'pOrph', label: 'bro: session' }], paneIds: ['pOrph'] });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    converge(armedTree(tree));
    // sessions adopts the orphan; renderer + status each split —
    // neither may grab a pane wearing another role's label
    const runs = called('pane', 'run', 'pOrph');
    assert.equal(runs.length, 1);
    assert.match(runs[0]![3]!, /herdr session-view/);
    assert.equal(loadState(scope).sessions[tree]?.pane_id, 'pOrph');
    assert.equal(called('pane', 'split').length, 2);
    assert.equal(loadState(scope).statuses[tree]?.pane_id !== 'pOrph', true);
    assert.equal(loadState(scope).renderers[tree]?.pane_id !== 'pOrph', true);
  });

  test('a stale session record on a closed workspace is dropped', () => {
    reset({ panes: [{ pane_id: 'pLive' }] });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    const p = armedTree(tree);
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
    const p = armedTree(tree);
    p.status.worktrees[0]!.branch = 'work/bead-1';
    p.status.loop.runs = [
      { beadId: 'bead-1', slug: 'bead-1', state: 'running', worktree: tree, silentMs: 16.5 * H },
    ];
    converge(p);
    const opens = called('worktree', 'open');
    assert.equal(opens.length, 1);
    const label = opens[0]![opens[0]!.indexOf('--label') + 1]!;
    assert.equal(label, `🤖 ${basename(tree)}`);
  });

  test('the plugin never renames or tokens a managed workspace', () => {
    reset();
    const tree = mkdtempSync(join(TMP, 'tree-'));
    const p = armedTree(tree);
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
    const p = armedTree(tree);
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
