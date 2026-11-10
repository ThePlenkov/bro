/** Drive conflict fixer e2e (spec bro-glkes) — a CONFLICTING orphan PR
 *  must spawn the rebase fixer, not log-and-skip 'blocked — merge
 *  conflicts' forever. The fake agent plays the rebase (flips the PR's
 *  mergeable → MERGEABLE); the next pass merges and closes the fixer
 *  bead. The non-spawn verdicts ride along: occupied (a live .work
 *  marker owns the branch) and the fixRounds>maxRounds cap. Runs the
 *  built CLI against the fake review host + fake bd like the loop e2e
 *  matrix. */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertNoSpawn,
  assertOrphanMerged,
  driveFixture,
  driveVerdict as verdict,
  exitRecorded,
  fixerRows,
  git,
  insideAsync,
  occupyBranch,
  readHostState,
  waitFor,
  writeHostState,
} from './testrepo.ts';

const fixture = () => driveFixture('bro-drive-conflict-');

/** One orphaned CONFLICTING PR on a fleet branch. */
const conflicting = {
  'work/fx-a': {
    number: 7,
    state: 'OPEN',
    headRef: 'work/fx-a',
    baseRef: 'main',
    mergeable: 'CONFLICTING',
  },
};

const events = (state: string): Array<Record<string, unknown>> =>
  (readHostState(state).events ?? []) as Array<Record<string, unknown>>;

describe('bro drive — conflicted orphan PRs (bro-glkes)', () => {
  test('CONFLICTING spawns the rebase fixer; the next pass merges and closes its bead', async () => {
    const f = fixture();
    await insideAsync(f.main, f.root, async () => {
      git(['branch', 'work/fx-a'], f.main);
      writeHostState(f.hostState, { prs: conflicting });

      const first = verdict(f.run(['--once', '--json']));
      assert.equal(first.verdict, 'spawned', first.detail);
      assert.match(first.detail ?? '', /rebase fx-/);

      // the fixer is detached — wait for its rebase event AND its exit
      // record before the next pass reads occupancy off the registry
      assert.equal(
        await waitFor(() => events(f.hostState).some(e => e.rebase !== undefined)),
        true,
        'the spawned fixer never ran its rebase order'
      );
      assert.equal(await waitFor(() => exitRecorded(f.main)), true);
      assert.match(readFileSync(join(f.main, 'spawns.log'), 'utf8'), /rebase rebased onto base/);

      // the fixer bead — the label + external_ref handle drive sweeps by
      const fixer = fixerRows(f.db)[0];
      assert.equal(fixer?.external_ref, 'drive:pr:7');

      // conflict cleared by the agent → gate green → orphan merge
      assertOrphanMerged(f, f.run(['--once', '--json']), fixer?.id);
    });
  });

  test('the base is fetched before the spawn — the rebase target is the tip, not a stale ref', async () => {
    // bro-by8d3: the repo's tracking refs are as old as the last fetch
    // anybody ran; the drive lane ran none. The rebase fixer must get
    // the base's tip at spawn time, and the work order must name it.
    const f = fixture();
    await insideAsync(f.main, f.root, async () => {
      git(['init', '-q', '--bare', join(f.root, 'origin.git')], f.root);
      git(['remote', 'add', 'origin', join(f.root, 'origin.git')], f.main);
      git(['push', '-qu', 'origin', 'main'], f.main);
      // main advances on the remote; the local tracking ref is dropped,
      // so only a fetch can bring the tip back
      git(['commit', '-qm', 'remote', '--allow-empty'], f.main);
      git(['push', '-q', 'origin', 'main'], f.main);
      const tip = git(['rev-parse', 'HEAD'], f.main).trim();
      git(['update-ref', '-d', 'refs/remotes/origin/main'], f.main);
      git(['branch', 'work/fx-a'], f.main);
      writeHostState(f.hostState, { prs: conflicting });

      const first = verdict(f.run(['--once', '--json']));
      assert.equal(first.verdict, 'spawned', first.detail);

      // the base tip is in the repo now — fetched by the drive, not by luck
      assert.equal(git(['rev-parse', 'origin/main'], f.main).trim(), tip);

      const agentsDir = join(f.main, '.git', 'bro', 'agents');
      assert.equal(
        await waitFor(
          () => existsSync(agentsDir) && readdirSync(agentsDir).some(n => n.endsWith('.prompt.md'))
        ),
        true
      );
      const pf = readdirSync(agentsDir).find(n => n.endsWith('.prompt.md'));
      assert.ok(pf !== undefined, 'the spawned fixer left no work order behind');
      const prompt = readFileSync(join(agentsDir, pf), 'utf8');
      assert.match(prompt, new RegExp(tip));
      assert.match(prompt, /Fetch the base AGAIN, immediately before the rebase/);
    });
  });

  test('an occupied conflicted PR stays occupied — never force-spawned', async () => {
    const f = fixture();
    await insideAsync(f.main, f.root, async () => {
      git(['branch', 'work/fx-a'], f.main);
      writeHostState(f.hostState, { prs: conflicting });
      // a live session marker naming the branch — the occupancy guard
      // must win over the fixer trigger
      occupyBranch(f.main, 'work/fx-a');
      assertNoSpawn(f, f.run(['--once', '--json']), 'occupied');
    });
  });

  test('fixRounds past maxRounds caps the spawn — plain blocked', async () => {
    const f = fixture();
    await insideAsync(f.main, f.root, async () => {
      git(['branch', 'work/fx-a'], f.main);
      // fixRounds = shas-1 = 4 > act.maxRounds 3 — the same cap the
      // thread path defers on; a rebase storm stops here too
      writeHostState(f.hostState, {
        prs: conflicting,
        reviewedShas: ['a', 'b', 'c', 'd', 'e'],
      });
      const r = f.run(['--once', '--json']);
      assert.match(verdict(r).detail ?? '', /merge conflicts/);
      assertNoSpawn(f, r, 'blocked');
    });
  });

  test('open threads preempt the rebase — the thread fixer gets the spawn', async () => {
    const f = fixture();
    await insideAsync(f.main, f.root, async () => {
      git(['branch', 'work/fx-a'], f.main);
      writeHostState(f.hostState, {
        prs: conflicting,
        threads: [
          {
            id: 't1',
            resolved: false,
            comment: {
              author: 'rev',
              bot: true,
              path: 'x.ts',
              line: 1,
              body: 'nit',
              createdAt: '2026-01-01',
            },
          },
        ],
      });
      const v = verdict(f.run(['--once', '--json']));
      assert.equal(v.verdict, 'spawned', v.detail);
      assert.match(v.detail ?? '', /^fx-/);
      // the spawned prompt is the thread work order, not the rebase one
      const agentsDir = join(f.main, '.git', 'bro', 'agents');
      assert.equal(
        await waitFor(
          () => existsSync(agentsDir) && readdirSync(agentsDir).some(n => n.endsWith('.prompt.md'))
        ),
        true
      );
      const pf = readdirSync(agentsDir).find(n => n.endsWith('.prompt.md'))!;
      const prompt = readFileSync(join(agentsDir, pf), 'utf8');
      assert.match(prompt, /unresolved review thread/);
      assert.doesNotMatch(prompt, /merge conflicts with its base branch/);
    });
  });
});
