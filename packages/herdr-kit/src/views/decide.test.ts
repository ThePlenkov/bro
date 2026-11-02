import assert from 'node:assert';
import test from 'node:test';
import {
  convergeViews,
  decideSession,
  decideSessionRetire,
  dropOrphanRecords,
  liveViewCommand,
  pickPane,
  sessionViewCommand,
} from './index.ts';

const LABEL = 'bro: session';
const BRO_LABELS = new Set([LABEL, 'bro: status']);
const live = (): Set<string> => new Set();

test('pickPane — orphan with our label adopts; idle unbound takes; bound never', () => {
  const panes = [
    { pane_id: 'p1', label: LABEL },
    { pane_id: 'p2', label: 'shell' },
    { pane_id: 'p3' },
  ];
  assert.deepEqual(
    pickPane(panes, live(), LABEL, BRO_LABELS, () => true),
    { id: 'p1', adopted: true }
  );
  // 'shell' isn't a bro-role label — p2 is a legal take when idle
  assert.deepEqual(
    pickPane(panes, new Set(['p1']), LABEL, BRO_LABELS, () => true),
    { id: 'p2', adopted: false }
  );
  // bro-role labels never taken even when idle
  const role = [{ pane_id: 'p9', label: 'bro: status' }];
  assert.deepEqual(
    pickPane(role, live(), LABEL, BRO_LABELS, () => true),
    { adopted: false }
  );
});

test('decideSession — recorded live pane keeps; idle re-arms; none splits; free arms', () => {
  const rec = { workspace: 'w', worktree: '/t', pane_id: 'pS' };
  const panes = [{ pane_id: 'p1' }, { pane_id: 'pS', label: LABEL }];
  // live recorded pane → none
  assert.deepEqual(
    decideSession({
      rec,
      panes,
      bound: live(),
      sessionLabel: LABEL,
      broLabels: BRO_LABELS,
      exists: () => true,
      idle: () => false,
    }),
    { kind: 'none' }
  );
  // recorded pane idle → rearm
  assert.deepEqual(
    decideSession({
      rec,
      panes,
      bound: live(),
      sessionLabel: LABEL,
      broLabels: BRO_LABELS,
      exists: () => true,
      idle: () => true,
    }),
    { kind: 'rearm', paneId: 'pS', adopted: true }
  );
  // no rec, free idle pane → arm
  assert.deepEqual(
    decideSession({
      panes: [{ pane_id: 'pX' }],
      bound: live(),
      sessionLabel: LABEL,
      broLabels: BRO_LABELS,
      exists: () => false,
      idle: () => true,
    }),
    { kind: 'arm', paneId: 'pX', adopted: false }
  );
  // nothing free → split off the first pane
  assert.deepEqual(
    decideSession({
      panes: [{ pane_id: 'p1', label: 'shell' }],
      bound: live(),
      sessionLabel: LABEL,
      broLabels: BRO_LABELS,
      exists: () => false,
      idle: () => false,
    }),
    { kind: 'split', targetId: 'p1' }
  );
});

test('decideSessionRetire — recorded-if-live else orphan label', () => {
  const rec = { workspace: 'w', worktree: '/t', pane_id: 'pS' };
  assert.deepEqual(
    decideSessionRetire({ rec, panes: [], sessionLabel: LABEL, exists: () => true }),
    { closeId: 'pS' }
  );
  assert.deepEqual(
    decideSessionRetire({
      rec,
      panes: [{ pane_id: 'pO', label: LABEL }],
      sessionLabel: LABEL,
      exists: () => false,
    }),
    { closeId: 'pO' }
  );
  assert.deepEqual(decideSessionRetire({ panes: [], sessionLabel: LABEL, exists: () => false }), {
    closeId: undefined,
  });
});

test('dropOrphanRecords — only records whose workspace is gone', () => {
  const recs = {
    '/a': { workspace: 'w1', worktree: '/a', pane_id: 'p' },
    '/b': { workspace: 'wGone', worktree: '/b', pane_id: 'p' },
  };
  assert.deepEqual(dropOrphanRecords(recs, new Set(['w1'])), ['/b']);
});

test('convergeViews — the retire/drop/rearm/keep/open table', () => {
  const agents = [
    { id: 'a1', events: '/e1' },
    { id: 'a2', events: '/e2', worktree: '/t2' },
    { id: 'a3', events: '/e3' },
    { id: 'a4', events: '/e4' },
    { id: 'a5', events: '/e5' },
  ];
  const existing = {
    a1: { workspace: 'w1', pane_id: 'p1', owned: true },
    a2: { workspace: 'w2', pane_id: 'p2' },
    a3: { workspace: 'w3', pane_id: 'p3' },
    a4: { workspace: 'w4', pane_id: 'p4' },
    gone: { workspace: 'wG', pane_id: 'pG', owned: true },
  };
  const acts = convergeViews({
    live: agents,
    existing,
    covered: new Set(['/t2']),
    exists: id => id !== 'p3',
    idle: id => id === 'p4',
  });
  assert.deepEqual(acts, [
    { kind: 'keep', id: 'a1', rec: existing.a1 },
    { kind: 'retire', id: 'a2', rec: existing.a2, reason: 'covered' },
    { kind: 'drop', id: 'a3', rec: existing.a3 },
    { kind: 'rearm', id: 'a4', rec: existing.a4 },
    { kind: 'retire', id: 'gone', rec: existing.gone, reason: 'dead' },
    { kind: 'open', agent: agents[2] }, // a3 re-opens after the drop
    { kind: 'open', agent: agents[4] }, // a5 is new
  ]);
});

test('view commands — verbs bare, values quoted, the two lanes', () => {
  const q = (s: string): string => `'${s}'`;
  assert.equal(
    sessionViewCommand('/t', { bun: 'bun', tui: '/main.ts', bro: 'bro' }, q),
    "'bun' run '/main.ts' '/t'"
  );
  assert.equal(sessionViewCommand('/t', { bro: 'bro' }, q), "'bro' herdr session-view '/t'");
  assert.equal(
    liveViewCommand(
      { events: '/e.jsonl', id: 'n1', worktree: '/t' },
      { bun: 'bun', tui: '/main.ts', bro: 'bro' },
      q
    ),
    "'bun' run '/main.ts' --events '/e.jsonl' --agent 'n1'"
  );
  assert.equal(
    liveViewCommand({ events: '/e.jsonl', id: 'n1' }, { bro: 'bro' }, q),
    "'bro' herdr session-view '.'"
  );
});
