/** `bro rig next` e2e — the stateless re-entry verb (bro-oy3k1.5):
 *  the verdict ladder over durable state — beads claims, the registry,
 *  queue labels, waiting frames, the forge — through the spawned CLI. */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { e2eRepo, git, installFakeHost, runCli, writeHostState } from './testrepo.ts';

const rig = (main: string, env: Record<string, string>, args: string[]) =>
  runCli(['rig', ...args], { cwd: main, env });

describe('bro rig next — the re-entry verb', () => {
  test('empty store reports done; an unknown id reports blocked', () => {
    const { main, env } = e2eRepo('bro-rignext-e2e-');
    const empty = rig(main, env, ['next']);
    assert.equal(empty.code, 0);
    assert.match(empty.stdout, /rig next: done/);
    const miss = rig(main, env, ['next', 'nope']);
    assert.equal(miss.code, 1);
    assert.match(miss.stdout, /rig next: blocked nope/);
  });

  test('queued item beats the ready list; parked frame reports wait', () => {
    const { main, env } = e2eRepo('bro-rignext-e2e-', [
      { id: 'q-1', title: 'queued', status: 'open', labels: ['queue:root', 'qrank:1'] },
      { id: 'r-1', title: 'ready', status: 'open' },
      {
        id: 'w-1',
        title: 'parked frame',
        status: 'open',
        labels: ['drill', 'waiting'],
        notes: 'context\nWAKE: gate green on #7',
      },
    ]);
    // no frame → queue:root top is the focus
    const top = rig(main, env, ['next']);
    assert.equal(top.code, 0);
    assert.match(top.stdout, /rig next: step q-1/);
    // an explicit waiting frame reports wait + its predicate
    const w = rig(main, env, ['next', 'w-1']);
    assert.equal(w.code, 0);
    assert.match(w.stdout, /rig next: wait w-1 — gate green on #7/);
  });

  test('open item outside the ready page still steps — deps gate, not page membership', () => {
    const { main, env, db } = e2eRepo('bro-rignext-e2e-', [
      { id: 'd-1', title: 'dep-gated', status: 'open' },
      { id: 'df-1', title: 'snoozed', status: 'open', defer_until: '2999-01-01' },
      { id: 's-1', title: 'slot', status: 'open', labels: ['gt:slot'] },
      { id: 'b-1', title: 'blocked-status', status: 'blocked' },
    ]);
    // a 'blocks' edge into d-1 — the fake's `dep list` answers db.deps
    // verbatim ignoring the queried id, so the edge must be cleared
    // before the other verdicts are read
    const raw = JSON.parse(readFileSync(db, 'utf8'));
    raw.deps = [{ issue_id: 'd-1', depends_on_id: 'x-1', type: 'blocks' }];
    writeFileSync(db, JSON.stringify(raw));
    assert.match(rig(main, env, ['next', 'd-1']).stdout, /rig next: blocked d-1 — dep-gated/);
    raw.deps = [];
    writeFileSync(db, JSON.stringify(raw));
    assert.match(rig(main, env, ['next', 'df-1']).stdout, /rig next: blocked df-1 — deferred/);
    assert.match(
      rig(main, env, ['next', 's-1']).stdout,
      /rig next: blocked s-1 — coordination slot/
    );
    assert.match(rig(main, env, ['next', 'b-1']).stdout, /rig next: blocked b-1 — status blocked/);
  });

  test('foreign claim reports blocked; own claim reports step', () => {
    const { main, env } = e2eRepo('bro-rignext-e2e-', [
      { id: 'c-1', title: 'theirs', status: 'in_progress', assignee: 'other-actor' },
      { id: 'c-2', title: 'mine', status: 'in_progress', assignee: 'tester' },
      { id: 'c-3', title: 'closed', status: 'closed' },
    ]);
    const blocked = rig(main, env, ['next', 'c-1']);
    assert.equal(blocked.code, 1);
    assert.match(blocked.stdout, /rig next: blocked c-1 — claimed by other-actor/);
    const own = rig(main, env, ['next', 'c-2']);
    assert.equal(own.code, 0);
    assert.match(own.stdout, /rig next: step c-2/);
    const done = rig(main, env, ['next', 'c-3']);
    assert.equal(done.code, 0);
    assert.match(done.stdout, /rig next: done c-3/);
  });

  test('a live registry agent reports wait; an open PR reports gate', () => {
    const { main, env } = e2eRepo('bro-rignext-e2e-', [
      { id: 'a-1', title: 'in flight', status: 'in_progress', assignee: 'tester' },
      { id: 'r-1', title: 'remote worker', status: 'in_progress', assignee: 'tester' },
      { id: 'g-1', title: 'pr up', status: 'open' },
    ]);
    // live agent — a real pid the probe can verify
    const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
    assert.ok(sleeper.pid !== undefined, 'sleep process did not start');
    const sleeperPid = sleeper.pid;
    try {
      const agentsDir = join(main, '.git', 'bro');
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(
        join(agentsDir, 'agents.json'),
        JSON.stringify({
          'a-1': {
            agentId: 'native-zz',
            backend: 'native',
            spawnedAt: new Date().toISOString(),
            pid: sleeperPid,
          },
          // a remote backend — no pid handle; absent a recorded death
          // the entry reads in-flight
          'r-1': {
            agentId: 'devin-zz',
            backend: 'devin',
            spawnedAt: new Date().toISOString(),
            sessionId: 'sess-1',
          },
        })
      );
      const live = rig(main, env, ['next', 'a-1']);
      assert.equal(live.code, 0);
      assert.match(live.stdout, /rig next: wait a-1 — agent native-zz in flight/);
      const remote = rig(main, env, ['next', 'r-1']);
      assert.equal(remote.code, 0);
      assert.match(remote.stdout, /rig next: wait r-1 — agent devin-zz in flight/);
    } finally {
      sleeper.kill('SIGKILL');
    }
    // gate — a worktree whose branch carries an open PR on the fake host
    const host = installFakeHost(main);
    writeFileSync(
      join(main, 'bro.config.json'),
      JSON.stringify({ plugins: ['./fakehost.ts'], connectors: { reviews: 'fakehost' } })
    );
    const wt = join(main, '..', 'main--g-1');
    git(['worktree', 'add', '-b', 'work/g-1', wt], main);
    assert.ok(existsSync(wt));
    writeHostState(host.state, { prOpened: true, pr: 7 });
    const gate = rig(main, env, ['next', 'g-1']);
    assert.equal(gate.code, 0);
    assert.match(gate.stdout, /rig next: gate g-1 — pr=#7/);
  });
});
