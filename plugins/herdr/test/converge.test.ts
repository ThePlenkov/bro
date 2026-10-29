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
import { join } from 'node:path';
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
  act: [],
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
    saveState(scope, s);
    converge(deadPlanes());
    assert.deepEqual(called('workspace', 'close', 'wDead').length, 1);
    const st = loadState(scope);
    assert.equal(st.gone[DEAD], undefined);
    assert.equal(st.workspaces[DEAD], undefined);
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
    assert.equal(runs.length, 1);
    assert.equal(runs[0]![2], 'p1');
    assert.match(runs[0]![3]!, /bus subscribe/);
    assert.match(runs[0]![3]!, /--topic worker/);
    assert.deepEqual(called('pane', 'rename', 'p1', 'bro: events').length, 1);
    assert.equal(loadState(scope).renderers[tree]?.pane_id, 'p1');
  });

  test('busy panes split instead of stealing the foreground', () => {
    reset({ panes: [{ pane_id: 'p1' }], busyPanes: ['p1'] });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    converge(armedTree(tree));
    assert.equal(called('pane', 'split', 'p1').length, 1);
    const runs = called('pane', 'run');
    assert.equal(runs.length, 1);
    assert.match(runs[0]![2]!, /^pSplit/);
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
    assert.equal(called('pane', 'split').length, 0);
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
    // the dead mirror is an exit marker, not a renderer — the tail arms
    assert.equal(called('pane', 'run').length, 1);
    assert.equal(loadState(scope).renderers[tree]?.pane_id, 'pTail');
  });

  test('a dead tail on a live pane re-arms in place', () => {
    reset({ panes: [{ pane_id: 'p1' }], paneIds: ['p1'] });
    const tree = mkdtempSync(join(TMP, 'tree-'));
    const s = loadState(scope);
    s.renderers[tree] = { workspace: 'wOpened', worktree: tree, pane_id: 'p1' };
    saveState(scope, s);
    converge(armedTree(tree));
    const runs = called('pane', 'run');
    assert.equal(runs.length, 1);
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
    assert.equal(called('pane', 'run').length, 0);
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

describe('status labels + metadata', () => {
  test('silent loop run + act-state join prefixes the open label', () => {
    reset();
    const tree = mkdtempSync(join(TMP, 'tree-'));
    const p = armedTree(tree);
    p.status.worktrees[0]!.branch = 'work/bead-1';
    p.status.loop.runs = [
      { beadId: 'bead-1', slug: 'bead-1', state: 'running', worktree: tree, silentMs: 16.5 * H },
    ];
    p.act = [
      {
        fetchedAt: Date.now(),
        state: { pr: 765, headRef: 'work/bead-1', state: 'OPEN', openThreads: 2 },
      },
    ];
    converge(p);
    const opens = called('worktree', 'open');
    assert.equal(opens.length, 1);
    const label = opens[0]![opens[0]!.indexOf('--label') + 1]!;
    assert.equal(label, '[silent16h·#765 blocked] Ship it');
  });

  test('label token updates rename an existing managed workspace', () => {
    reset();
    const tree = mkdtempSync(join(TMP, 'tree-'));
    const p = armedTree(tree);
    p.worktrees.worktrees = [{ path: tree, open_workspace_id: 'w1' }];
    p.workspaces = [{ workspace_id: 'w1', label: 'Ship it' }];
    // the recorded workspace is ours, so drift correction may rename it
    const s = loadState(scope);
    s.workspaces[tree] = { ws: 'w1', label: 'Ship it', managed: true };
    saveState(scope, s);
    p.status.loop.runs = [
      { beadId: 'bead-1', slug: 'bead-1', state: 'running', worktree: tree, silentMs: 10 * H },
    ];
    converge(p);
    const renames = called('workspace', 'rename', 'w1');
    assert.equal(renames.length, 1);
    assert.equal(renames[0]![3], '[silent10h] Ship it');
  });

  test('report-metadata tokens mirror the label once per change', () => {
    reset();
    const tree = mkdtempSync(join(TMP, 'tree-'));
    const p = armedTree(tree);
    p.status.loop.runs = [
      { beadId: 'bead-1', slug: 'bead-1', state: 'running', worktree: tree, silentMs: 10 * H },
    ];
    converge(p);
    const metas = called('workspace', 'report-metadata');
    assert.equal(metas.length, 1);
    assert.ok(metas[0]!.includes('bro.worker=silent10h'));
    // second pass over the post-open planes — herdr's list now carries
    // the opened workspace; nothing moved, nothing is written
    p.worktrees.worktrees = [{ path: tree, open_workspace_id: 'wOpened' }];
    p.workspaces = [{ workspace_id: 'wOpened', label: '[silent10h] Ship it' }];
    converge(p);
    assert.equal(called('workspace', 'report-metadata').length, 1);
  });
});
