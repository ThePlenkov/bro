/** Loop auto-merge e2e — the claim → worktree → agent → gate → merge →
 *  close → cleanup pipeline run against the built CLI. A node shim plays
 *  bd (JSON-file store via FAKE_BD_DB) and an external connector plugin
 *  plays the review host (host.json state file), so the real merge path
 *  is exercised with no bd/gh/network. The regression cost here is a PR
 *  merged without a gate or a bead stranded claimed — the assertions
 *  check store state, refs, and the worktree, not just output. */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CLI_DIST,
  FAKE_BEAD,
  assertLandedBead,
  bead,
  e2eEnv,
  git,
  initRepo,
  inside,
  installFakeBd,
  installFakeHost,
  killRunHandles,
  readHostState,
  runCli,
  writeHostState,
  type CliResult,
} from './testrepo.ts';

interface Fixture {
  root: string;
  main: string;
  db: string;
  hostState: string;
  /** The fake agent script's path — provider commands reference it. */
  agent: string;
  worktree: string;
  /** The raw env `run` passes to runCli — exposed so a test can spawn
   *  the CLI directly (a run that must NOT exit gets a shorter
   *  timeout than runCli's 60s). */
  env: Record<string, string>;
  run: (extra?: string[]) => CliResult;
}

/** Repo + fake bd + fake host + bro.config wiring. `rows` are the ready
 *  queue; `loopCfg` merges into the loop section (fixRounds etc.);
 *  `extra` merges more top-level config (providers, fleet) built from
 *  the installed host paths. HOME points at the fixture root so an
 *  operator's ~/.config/bro providers can't hijack a bare run now that
 *  the loop resolves the provider lane. */
function loopFixture(
  rows: Array<Record<string, unknown>>,
  loopCfg: Record<string, unknown> = {},
  scenario = 'land',
  extra: (host: { state: string; agent: string }) => Record<string, unknown> = () => ({})
): Fixture {
  const { root, main } = initRepo('bro-loop-e2e-');
  const { binDir, db } = installFakeBd(root, rows);
  const host = installFakeHost(main);
  writeFileSync(
    join(main, 'bro.config.json'),
    JSON.stringify({
      plugins: ['./fakehost.ts'],
      connectors: { reviews: 'fakehost' },
      ...extra(host),
      loop: {
        agent: `node ${host.agent}`,
        // e2e must be environment-deterministic: a host /tmp under the
        // default floor (2×400M) would hold every push in EVERY
        // scenario — disk coverage opts back in explicitly
        diskMinSlots: 0,
        ...loopCfg,
      },
    })
  );
  const env = {
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    HOME: root,
    FAKE_BD_DB: db,
    FAKE_HOST_STATE: host.state,
    E2E_SCENARIO: scenario,
  };
  return {
    root,
    main,
    db,
    hostState: host.state,
    agent: host.agent,
    worktree: join(root, 'main--fx-a'),
    env,
    run: (extra = []) =>
      // the test clock: a fractional interval is the fixture's fake
      // time — every poll/sleep the run derives scales to 100ms
      // instead of the production 60s/1s cadences
      runCli(
        [
          'loop',
          ...(extra.some(a => a === '--interval' || a.startsWith('--interval='))
            ? []
            : ['--interval', '0.1']),
          ...extra,
        ],
        { cwd: main, env }
      ),
  };
}

/** Fake `bro` binary — wins `broSpawnArgv`'s PATH scan ahead of any real
 *  install, so an acp provider's `bro acp-worker …` argv lands here.
 *  Plays the driver: records argv + provenance env, then does the land
 *  scenario (the real driver would serve an ACP session instead). */
const FAKE_BRO = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const args = process.argv.slice(2)
const pf = args[args.length - 1]
const STATE = process.env.FAKE_HOST_STATE
// a transient fs/spawn hiccup (EMFILE/EAGAIN on a loaded CI runner)
// must not kill the worker — a one-shot crash parks a good bead (the
// batch e2e's '4 landed' flake, bro-6u1tu)
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const retry = (fn) => {
  for (let i = 0; ; i++) {
    try { return fn() } catch (e) {
      if (i > 40) throw e
      pause(25)
    }
  }
}
const load = () => retry(() => JSON.parse(fs.readFileSync(STATE, 'utf8')))
// retry only spawn hiccups (the error carries e.code) — a non-zero
// exit means the command ran, and re-running a non-idempotent op
// ('git commit' → 'nothing to commit') parks a landed bead as a crash
const sh = (cmd, args) => {
  for (let i = 0; ; i++) {
    try { return execFileSync(cmd, args, { encoding: 'utf8' }) } catch (e) {
      if (e.code === undefined || i > 40) throw e
      pause(25)
    }
  }
}
// host.json mutations serialize on the same mkdir lock the fake
// agent/plugin hold — workers are detached processes, not in-order
const LOCK = STATE + '.lock'
const save = (s) => {
  const tmp = STATE + '.tmp.' + process.pid
  retry(() => {
    fs.writeFileSync(tmp, JSON.stringify(s))
    fs.renameSync(tmp, STATE)
  })
}
const withState = (fn) => {
  for (let i = 0; ; i++) {
    try { fs.mkdirSync(LOCK); break } catch (e) {
      if (e.code !== 'EEXIST') throw e
      if (i > 2000) throw new Error('host state lock wedged')
      pause(5)
    }
  }
  try { const s = load(); const r = fn(s); save(s); return r }
  finally { fs.rmSync(LOCK, { recursive: true, force: true }) }
}
retry(() => fs.appendFileSync(
  path.join(path.dirname(STATE), 'acpworker.log'),
  JSON.stringify({
    args,
    promptFile: pf,
    promptOk: fs.existsSync(pf),
    bead: process.env.BRO_BEAD_ID || null,
    provider: process.env.BRO_AGENT_PROVIDER || null,
    batch: process.env.BRO_BATCH || null,
    broEnv: Object.keys(process.env).filter((k) => k.startsWith('BRO')).sort().join(','),
    agent: process.env.BRO_AGENT || null,
    model: process.env.BRO_AGENT_MODEL || null,
    class: process.env.BRO_AGENT_CLASS || null,
  }) + '\\n'
))
if (retry(() => fs.readFileSync(pf, 'utf8')).includes('review-threads')) {
  withState((s) => { s.threads = [] })
  process.exit(0)
}
retry(() => fs.writeFileSync('work.txt', 'did the thing\\n'))
sh('git', ['add', '-A'])
sh('git', ['commit', '-qm', 'feat: the thing'])
withState((s) => { s.prOpened = true })
`;

/** Install the fake `bro` beside the fake `bd` — same dir, first on
 *  the fixture PATH. */
function installFakeBro(root: string): void {
  const bro = join(root, 'bin', 'bro');
  writeFileSync(bro, FAKE_BRO);
  chmodSync(bro, 0o755);
}

const spawns = (f: Fixture): string =>
  existsSync(join(f.main, 'spawns.log')) ? readFileSync(join(f.main, 'spawns.log'), 'utf8') : '';

/** The same-area P3 debt pair the clump tests bind on `area:cli` —
 *  fx-a leads and fx-b rides as the compatible member. */
const cliDebtPair = (): Array<Record<string, unknown>> => [
  { ...FAKE_BEAD, id: 'fx-a', title: 'cli drift 1', priority: 3, labels: ['debt', 'area:cli'] },
  { ...FAKE_BEAD, id: 'fx-b', title: 'cli drift 2', priority: 3, labels: ['debt', 'area:cli'] },
];

describe('bro loop e2e', () => {
  test('land: claim → agent → green gate → merge → close → cleanup', () => {
    const f = loopFixture([{ ...FAKE_BEAD, id: 'fx-a', title: 'ship it' }]);
    inside(f.main, f.root, () => {
      // the default 0.1s test tick lands the run inside the heartbeat
      // floor — the liveness guard staying quiet still proves a clean
      // run (the heartbeat's floor, not its interval, is what bounds it)
      const r = f.run();
      assert.match(r.stdout, /loop: fx-a landed/);
      assert.match(r.stdout, /1 landed, 0 closed, 0 parked, 0 failed/);
      // the bead is closed in the shared store, the worktree and its
      // branch are gone, and the audit reports no tails
      assert.equal(bead(f.db, 'fx-a')?.status, 'closed');
      assert.equal(existsSync(f.worktree), false);
      assert.match(r.stdout, /clean — no loop tails/);
      assert.match(spawns(f), /work opened pr/);
      // the worker spawned through the agents registry (bro-zpa93) —
      // its prompt/log/.exit land under <git-common>/bro/agents/ and
      // the entry survives the loop: a detached worker's exit stays
      // decidable after the spawner dies (bro-snga4)
      const registry = JSON.parse(
        readFileSync(join(f.main, '.git', 'bro', 'agents.json'), 'utf8')
      ) as Record<string, { agentId: string; log?: string; exitStatus?: number }>;
      const entry = registry['fx-a'];
      assert.ok(entry, 'no agents-registry entry for fx-a');
      assert.ok(entry.log !== undefined && existsSync(entry.log), 'worker log missing');
      assert.match(readFileSync(entry.log!, 'utf8'), /agent land on fx-a/);
      assert.equal(
        readFileSync(join(f.main, '.git', 'bro', 'agents', `${entry.agentId}.exit`), 'utf8').trim(),
        '0'
      );
      // the harvest landed the exit classification on the entry too
      assert.equal(entry.exitStatus, 0);
      // the liveness guard stays quiet on a clean run — no phantom
      // heartbeats, no mid-run audit on a normal exit
      assert.doesNotMatch(r.stderr, /loop: alive —/);
      assert.doesNotMatch(r.stderr, /exiting mid-run/);
    });
  });

  test('the pick consults the verdict ladder — parked/live-worker beads skip (bro-oy3k1.6)', () => {
    // claimClump's filter asks rigNext now: a `waiting`-labelled bead
    // (a parked frame) and a bead with a live registry worker are not
    // claimable even though raw status still reads open — the loop
    // steps down the chain to the first `step` verdict
    const f = loopFixture([
      { ...FAKE_BEAD, id: 'fx-parked', title: 'shelved', labels: ['waiting'], priority: 1 },
      { ...FAKE_BEAD, id: 'fx-live', title: 'in flight', priority: 2 },
      { ...FAKE_BEAD, id: 'fx-b', title: 'ship it', priority: 3 },
    ]);
    inside(f.main, f.root, () => {
      // a live registry entry pins fx-live — pidAlive sees this very
      // test process, no fake sleeper needed
      const agentsDir = join(f.main, '.git', 'bro');
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(
        join(agentsDir, 'agents.json'),
        JSON.stringify({
          'fx-live': {
            agentId: 'native-live',
            backend: 'native',
            spawnedAt: new Date().toISOString(),
            pid: process.pid,
          },
        })
      );
      const r = f.run();
      assert.match(r.stdout, /loop: fx-b landed/);
      assert.match(r.stdout, /1 landed, 0 closed, 0 parked, 0 failed/);
      assert.equal(bead(f.db, 'fx-b')?.status, 'closed');
      // both verdict-skipped beads stay untouched in the store
      assert.equal(bead(f.db, 'fx-parked')?.status, 'open');
      assert.equal(bead(f.db, 'fx-live')?.status, 'open');
    });
  });

  test('the run record rides the registry worker — the check-in planes see it (bro-wg896)', () => {
    const f = loopFixture([{ ...FAKE_BEAD, id: 'fx-a', title: 'ship it' }]);
    inside(f.main, f.root, () => {
      const r = f.run();
      assert.match(r.stdout, /loop: fx-a landed/);
      const peeks = (readHostState(f.hostState).loopPeeks ?? []) as Array<{
        at: string;
        records: Record<
          string,
          { beadId?: string; beadIds?: string[]; pid?: number; worktree?: string; log?: string }
        >;
      }>;
      // the record exists from the worker's first instruction — an
      // early peek may still read the claim-custody stamp (spawn()
      // resolves after the fork races it), so only identity is
      // asserted here; the custody fields land by worker-done
      const startPeek = peeks.find(p => p.at === 'worker-start');
      assert.ok(startPeek, 'worker-phase loop peek missing');
      const startRec = startPeek.records['fx-a'];
      assert.ok(startRec, 'no loop run record while the registry worker ran');
      assert.equal(startRec.beadId, 'fx-a');
      assert.equal(startRec.worktree, f.worktree);
      // by the worker's end the record carries its pid + agents-plane
      // log — the row `bro watch`/`bro status` renders
      const donePeek = peeks.find(p => p.at === 'worker-done');
      assert.ok(donePeek, 'worker-done loop peek missing');
      const rec = donePeek.records['fx-a'];
      assert.ok(rec, 'loop run record gone before the worker even exited');
      assert.ok(typeof rec.pid === 'number' && rec.pid > 0);
      assert.match(rec.log ?? '', /bro[/\\]agents[/\\].+\.log$/);
      // the settle window (worker exited, PR lookup in flight) keeps
      // the record — custody back with the loop process
      const settlePeek = peeks.find(p => p.at === 'pr-lookup' && p.records['fx-a']);
      assert.ok(settlePeek, 'no loop run record during the PR-lookup window');
      // once the watch marker arms, the record retires — every gate
      // poll must read an empty plane, and the run leaves no residue
      for (const p of peeks.filter(p => p.at === 'gate')) {
        assert.equal(p.records['fx-a'], undefined, 'run record leaked into the gate phase');
      }
      assert.equal(existsSync(join(f.main, '.git', 'bro', 'loop', 'fx-a.json')), false);
    });
  });

  test('the gate wait arms a rearmable watch marker (bro-z0k2u)', () => {
    const f = loopFixture([{ ...FAKE_BEAD, id: 'fx-a', title: 'ship it' }]);
    inside(f.main, f.root, () => {
      const r = f.run();
      assert.match(r.stdout, /loop: fx-a landed/);
      // the marker is retired when the wait settles — the fake host
      // snapshots the watches dir mid-poll so the arm stays observable
      const peeks = (readHostState(f.hostState).watchPeeks ?? []) as Array<{
        file: string;
        marker: {
          pr: number;
          pid: number;
          merge: boolean;
          cleanup?: boolean;
          workdir?: string;
          bead?: string;
          timeoutMin: number;
        };
      }>;
      const hit = peeks.find(p => p.marker.pr === 7);
      assert.ok(hit, 'gate wait never armed a watch marker');
      // the act-wait shape <pr>-<pid>-<nonce>.json — what `act rearm`
      // recognizes as a resurrectable wait
      assert.match(hit.file, /^7-\d+-[0-9a-f]+\.json$/);
      assert.equal(hit.marker.merge, true);
      assert.equal(hit.marker.cleanup, true);
      assert.equal(hit.marker.workdir, f.worktree);
      // the bead rides the marker — a resurrected wait runs the
      // finalizeMerge close the dead loop never reached (bro-q6ppv)
      assert.equal(hit.marker.bead, 'fx-a');
    });
  });

  test('discovery stamps bro-managed + the provenance trailer (bro-c650l)', () => {
    const f = loopFixture([{ ...FAKE_BEAD, id: 'fx-a', title: 'ship it' }]);
    inside(f.main, f.root, () => {
      const r = f.run();
      assert.match(r.stdout, /loop: fx-a landed/);
      // the stamp lands at findPr — every loop PR crosses it, no
      // worker pr-create flag needed
      const host = readHostState(f.hostState);
      assert.deepEqual(host.labels, ['bro-managed']);
      assert.equal(
        host.prBody,
        '<!-- bro: {"managed":true,"bead":"fx-a","mode":"loop","run":"loop/fx-a"} -->'
      );
      // the marker IS the merge-mode contract — a stamped PR lands
      // without the act-merge human-owned warning
      assert.doesNotMatch(r.stderr, /carries no bro-managed/);
    });
  });

  test('dry-run prints the plan and claims nothing', () => {
    const f = loopFixture([{ ...FAKE_BEAD, id: 'fx-a', title: 'ship it' }]);
    inside(f.main, f.root, () => {
      const r = f.run(['--dry-run']);
      assert.match(r.stdout, /would claim fx-a/);
      assert.match(r.stdout, /loop\/fx-a/);
      assert.equal(bead(f.db, 'fx-a')?.status, 'open');
      assert.equal(existsSync(f.worktree), false);
    });
  });

  test('dry-run reports the disk verdict — HOLD below floor, free space otherwise (bro-2spp7)', () => {
    // a worktreeMb bigger than the real disk trips the floor on every
    // probe — the dry run must say HOLD instead of pretending the plan
    // is pushable
    const f = loopFixture([{ ...FAKE_BEAD, id: 'fx-a', title: 'disk hog' }], {
      worktreeMb: 99_000_000,
      diskMinSlots: 2,
    });
    inside(f.main, f.root, () => {
      const r = f.run(['--dry-run']);
      assert.match(r.stdout, /disk: \d+M free on/);
      assert.match(r.stdout, /disk: HOLD — below floor \d+M \(2×99000000M\)/);
      // --disk-min-slots 0 is the escape hatch — same price, floor off
      const off = f.run(['--dry-run', '--disk-min-slots', '0']);
      assert.match(off.stdout, /disk: \d+M free on/);
      assert.doesNotMatch(off.stdout, /disk: HOLD/);
    });
  });

  test('disk floor: pushes hold instead of claiming into ENOSPC (bro-2spp7)', () => {
    // every probe is below a ~99TB-priced floor — the run must hold
    // pushes (never claim, never park) the way it does on a full fleet
    const f = loopFixture([{ ...FAKE_BEAD, id: 'fx-a', title: 'disk hog' }], {
      worktreeMb: 99_000_000,
      diskMinSlots: 2,
    });
    inside(f.main, f.root, () => {
      // a holding run is correct-by-design non-terminating — the test's
      // own timeout (not runCli's 60s) bounds it and the captured
      // output is the evidence
      const proc = spawnSync(process.execPath, [CLI_DIST, 'loop', '--interval', '0.1'], {
        cwd: f.main,
        env: e2eEnv(f.env),
        encoding: 'utf8',
        timeout: 4_000,
      });
      assert.equal(proc.status, null, 'run should have held until the test timeout');
      const stdout = proc.stdout ?? '';
      const stderr = proc.stderr ?? '';
      // exactly one hold line per episode — a re-breach does not re-log
      assert.equal(stdout.match(/disk below floor/g)?.length, 1);
      assert.match(stdout, /disk below floor .* pushes held/);
      // the heartbeat names the wait — a disk-stuck run is a named
      // stall, never a silent one
      assert.match(stderr, /loop: alive — idle \(disk floor\)/);
      // nothing claimed, nothing parked, nothing minted
      assert.equal(bead(f.db, 'fx-a')?.status, 'open');
      assert.equal(existsSync(f.worktree), false);
    });
  });

  test('disk floor: an empty queue still drains — the hold is not forever (bro-2spp7)', () => {
    // the breach return must not starve the drain check — with nothing
    // claimable behind the floor the run reports done instead of
    // holding pushes on an empty store until the disk frees
    const f = loopFixture([], { worktreeMb: 99_000_000, diskMinSlots: 2 });
    inside(f.main, f.root, () => {
      const r = f.run();
      assert.match(r.stdout, /done — 0 landed, 0 closed, 0 parked, 0 failed/);
    });
  });

  test('a throwing claim read degrades to a held push — never a supervisor death (bro-etimout)', () => {
    // a store wedged past bd's 15s budget throws out of claimClump's
    // bd ready — uncaught it killed the loop supervisor three times in
    // one day (raw spawnSync ETIMEDOUT, exit 1). The claim read must
    // degrade: warn + hold pushes, then retry — the SAME run lands the
    // bead once the store answers again. A failed read is not an empty
    // queue: drained stays unset, so 'done' never lies either way.
    const f = loopFixture([{ ...FAKE_BEAD, id: 'fx-a', title: 'slow store' }]);
    // one injected failure — the first claim read throws, the retry
    // after the hold succeeds
    f.env.FAKE_BD_READY_FAILS = '1';
    inside(f.main, f.root, () => {
      const r = f.run();
      // the message spans the wrapped spawn error (multi-line) — anchor
      // the two halves instead of one dot-all
      assert.match(r.stdout, /loop: claim read failed — [\s\S]*?holding pushes for [\d.]+s/);
      // the same run recovered and finished the pipeline — exit 0, no
      // raw err.message death at the supervisor's top level
      assert.equal(r.code, 0);
      assert.match(r.stdout, /done — 1 landed/);
      assertLandedBead(f.db, 'fx-a');
    });
  });

  test('agent exit != 0 without a PR → bead reopened + noted, worktree kept', () => {
    // crashExitMs:0 disables the crash-park guard — this tests the
    // legacy reopen path for a genuine mid-work failure
    const f = loopFixture(
      [{ ...FAKE_BEAD, id: 'fx-a', title: 'doomed' }],
      { crashExitMs: 0 },
      'fail'
    );
    inside(f.main, f.root, () => {
      const r = f.run();
      assert.match(r.stdout, /1 failed/);
      const row = bead(f.db, 'fx-a');
      assert.equal(row?.status, 'open');
      assert.match(String(row?.notes), /exited 3 without a PR/);
      assert.equal(existsSync(f.worktree), true);
      assert.match(r.stdout, /worktrees: .*main--fx-a/);
    });
  });

  test('agent gone in <crashExitMs → parked, claim snoozed not held (bro-sovl3/bro-hl22w)', () => {
    // the exit-3-instantly shape that burned the supervisor: reopening
    // reclaims the bead into the same broken spawn — park instead. The
    // claim releases into a deferred snooze: hidden from ready for the
    // cooldown, never an in_progress strand
    const f = loopFixture([{ ...FAKE_BEAD, id: 'fx-a', title: 'doomed' }], {}, 'fail');
    inside(f.main, f.root, () => {
      const r = f.run();
      assert.match(r.stdout, /1 parked/);
      assert.match(r.stdout, /parked \(crash, not work\)/);
      const row = bead(f.db, 'fx-a');
      assert.equal(row?.status, 'deferred');
      assert.ok(Date.parse(String(row?.defer_until)) > Date.now());
      assert.equal(row?.assignee ?? '', '');
      assert.match(String(row?.notes), /environment crash, not a verdict; parked/);
      assert.equal(existsSync(f.worktree), true);
    });
  });

  test('a parkedWakeMin past the clock horizon clamps — the park still lands (bro-hl22w)', () => {
    // an unbounded snooze overflows Date into a toISOString() RangeError
    // thrown BEFORE the per-bead catch — the abort would strand the
    // claims in_progress. The cap keeps any absurd value a valid defer.
    const f = loopFixture(
      [{ ...FAKE_BEAD, id: 'fx-a', title: 'doomed' }],
      { parkedWakeMin: 1e15 },
      'fail'
    );
    inside(f.main, f.root, () => {
      const r = f.run();
      assert.match(r.stdout, /1 parked/);
      const row = bead(f.db, 'fx-a');
      assert.equal(row?.status, 'deferred');
      const wake = Date.parse(String(row?.defer_until));
      assert.ok(Number.isFinite(wake) && wake > Date.now());
    });
  });

  test('worker exits rate_limited with a provider reset → waits the reset, respawns the same order (bro-36bhc)', () => {
    // the incident shape: a worker dying on a provider rate wall is a
    // WAIT, never a verdict — the loop holds the claim until the reset
    // and respawns the same work order (convoy's blockedDecision), it
    // does not reopen the bead and spawn the NEXT claim into the wall
    const f = loopFixture([{ ...FAKE_BEAD, id: 'fx-a', title: 'walled' }], {}, 'wall')
    inside(f.main, f.root, () => {
      const r = f.run()
      assert.match(r.stdout, /rate_limited/)
      assert.match(r.stdout, /loop: fx-a landed/)
      assert.match(r.stdout, /1 landed, 0 closed, 0 parked, 0 failed/)
      assertLandedBead(f.db, 'fx-a')
      const evs = (readHostState(f.hostState).events ?? []) as Array<Record<string, unknown>>
      // one wall death, one post-reset respawn — a third spawn would
      // mean the loop churned a session into the wall
      assert.equal(evs.filter((e) => e.wallSpawn === 'fx-a').length, 1)
      assert.equal(evs.filter((e) => e.spawn === 'fx-a').length, 1)
      assert.equal(
        spawns(f).trim().split('\n').filter(Boolean).length,
        2
      )
    })
  })

  test('a member waiting on a wall holds pushes — the next claim spawns after the reset (bro-36bhc)', () => {
    // a wall wait is an ACCOUNT fact: claiming the next bead while a
    // member waits burns that bead's spawn on the same wall — the six
    // consecutive deaths of the incident. fx-b's worker must not start
    // until fx-a's reset passed.
    const f = loopFixture(
      [
        { ...FAKE_BEAD, id: 'fx-a', title: 'walled', priority: 1 },
        { ...FAKE_BEAD, id: 'fx-b', title: 'queued', priority: 2 },
      ],
      {},
      'wall'
    )
    inside(f.main, f.root, () => {
      const r = f.run()
      assert.match(r.stdout, /rate wall/)
      assert.match(r.stdout, /2 landed, 0 closed, 0 parked, 0 failed/)
      const evs = (readHostState(f.hostState).events ?? []) as Array<Record<string, unknown>>
      const death = evs.find((e) => e.wallSpawn === 'fx-a')
      const fxbSpawn = evs.find((e) => e.spawn === 'fx-b')
      assert.ok(death !== undefined, 'fx-a never hit the wall')
      assert.ok(fxbSpawn !== undefined, 'fx-b never spawned')
      // fx-b never died on the wall itself — and the timing proves
      // why: its worker started only after fx-a's reset passed
      assert.equal(evs.filter((e) => e.wallSpawn === 'fx-b').length, 0)
      assert.ok(
        (fxbSpawn.at as number) >= Date.parse(death.resetAt as string),
        `fx-b spawned at ${String(fxbSpawn.at)} inside the wall (reset ${String(death.resetAt)})`
      )
    })
  })

  test('worker exits quota with no reset → parked, never churned (bro-36bhc)', () => {
    // the wall with no advertised end — the claim snoozes with the
    // cause named; reopening is the respawn-burn the park exists to kill
    const f = loopFixture([{ ...FAKE_BEAD, id: 'fx-a', title: 'walled' }], {}, 'quota')
    inside(f.main, f.root, () => {
      const r = f.run()
      assert.match(r.stdout, /1 parked/)
      // one spawn, then the park — no reopen, no respawn into the wall
      assert.equal(
        spawns(f).trim().split('\n').filter(Boolean).length,
        1
      )
      const row = bead(f.db, 'fx-a')
      assert.equal(row?.status, 'deferred')
      assert.match(String(row?.notes), /quota/)
      assert.equal(existsSync(f.worktree), true)
    })
  })

  test('agent verdict: bd close without a PR → closed, never reopened', () => {
    const f = loopFixture([{ ...FAKE_BEAD, id: 'fx-a', title: 'nothing to ship' }], {}, 'verdict');
    inside(f.main, f.root, () => {
      const r = f.run();
      assert.match(r.stdout, /closed by the agent — verdict/);
      assert.match(r.stdout, /1 closed/);
      const row = bead(f.db, 'fx-a');
      assert.equal(row?.status, 'closed');
      assert.equal(row?.close_reason, 'nothing to ship');
    });
  });

  test('open threads with fixRounds=0 → parked, claim snoozed + worktree kept', () => {
    const f = loopFixture([{ ...FAKE_BEAD, id: 'fx-a', title: 'contested' }], { fixRounds: 0 });
    writeHostState(f.hostState, {
      threads: [
        {
          id: 't1',
          resolved: false,
          outdated: false,
          comment: {
            author: 'reviewer',
            bot: false,
            path: 'work.txt',
            line: 1,
            body: 'fix this first',
            createdAt: '2026-01-01',
          },
        },
      ],
    });
    inside(f.main, f.root, () => {
      const r = f.run();
      assert.match(r.stdout, /1 parked/);
      const row = bead(f.db, 'fx-a');
      assert.equal(row?.status, 'deferred');
      assert.match(String(row?.notes), /blocked: 1 unresolved/);
      assert.equal(existsSync(f.worktree), true);
    });
  });

  test('fix round: threads → agent respawn → resolved → landed', () => {
    const f = loopFixture([{ ...FAKE_BEAD, id: 'fx-a', title: 'iterate' }], { fixRounds: 2 });
    writeHostState(f.hostState, {
      threads: [
        {
          id: 't1',
          resolved: false,
          outdated: false,
          comment: {
            author: 'reviewer',
            bot: false,
            path: 'work.txt',
            line: 1,
            body: 'fix this first',
            createdAt: '2026-01-01',
          },
        },
      ],
    });
    inside(f.main, f.root, () => {
      const r = f.run();
      assert.match(r.stdout, /fix round 1/);
      assert.match(r.stdout, /loop: fx-a landed/);
      const log = spawns(f);
      assert.match(log, /work opened pr/);
      assert.match(log, /fix resolved threads/);
      // the registry log appends across respawns — the fix round's
      // worker REUSES the agent id, so the same file continues the
      // bead's trail (spec bro-zpa93)
      const registry = JSON.parse(
        readFileSync(join(f.main, '.git', 'bro', 'agents.json'), 'utf8')
      ) as Record<string, { log?: string }>;
      const runLog = readFileSync(String(registry['fx-a']?.log), 'utf8');
      assert.equal(runLog.trim().split('\n').length, 2);
      assert.equal(bead(f.db, 'fx-a')?.status, 'closed');
    });
  });

  test('merge accepted but not landed (queue hold) → parked, not failed', () => {
    const f = loopFixture([{ ...FAKE_BEAD, id: 'fx-a', title: 'queued' }]);
    writeHostState(f.hostState, { mergeResult: 'OPEN' });
    inside(f.main, f.root, () => {
      const r = f.run();
      assert.match(r.stdout, /1 parked/);
      const row = bead(f.db, 'fx-a');
      assert.equal(row?.status, 'deferred');
      assert.match(String(row?.notes), /did not land \(state=OPEN\)/);
      assert.equal(existsSync(f.worktree), true);
    });
  });

  test('PR closed unmerged while the gate polls → parked, bead kept', () => {
    const f = loopFixture([{ ...FAKE_BEAD, id: 'fx-a', title: 'rejected' }]);
    writeHostState(f.hostState, { prState: 'CLOSED' });
    inside(f.main, f.root, () => {
      const r = f.run();
      assert.match(r.stdout, /1 parked/);
      const row = bead(f.db, 'fx-a');
      assert.equal(row?.status, 'deferred');
      assert.match(String(row?.notes), /closed unmerged/);
    });
  });

  test('PR lookup failure → parked — never reopens a bead whose PR may exist', () => {
    const f = loopFixture([{ ...FAKE_BEAD, id: 'fx-a', title: 'flaky host' }]);
    writeHostState(f.hostState, { prLookupFails: true });
    inside(f.main, f.root, () => {
      const r = f.run();
      assert.match(r.stdout, /1 parked/);
      const row = bead(f.db, 'fx-a');
      assert.equal(row?.status, 'deferred');
      assert.match(String(row?.notes), /PR lookup failed/);
      assert.equal(existsSync(f.worktree), true);
    });
  });

  test('empty queue → done with a clean audit', () => {
    const f = loopFixture([]);
    inside(f.main, f.root, () => {
      const r = f.run();
      assert.match(r.stdout, /0 landed, 0 closed, 0 parked, 0 failed/);
      assert.match(r.stdout, /clean — no loop tails/);
    });
  });

  test('batch: same-affinity beads clump — one worker, one PR closes all', () => {
    // the motivating shape: a queue of same-area debt — one claim pulls
    // the compatible tail into a single worktree + worker + PR
    const f = loopFixture(
      [
        ...cliDebtPair(),
        { ...FAKE_BEAD, id: 'fx-c', title: 'ui drift', priority: 3, labels: ['debt', 'area:ui'] },
      ],
      { batch: 4 },
      'batch'
    );
    writeHostState(f.hostState, { prs: {} });
    inside(f.main, f.root, () => {
      const r = f.run();
      // fx-a leads; fx-b joins on the shared area key; fx-c is foreign
      // affinity and must claim on its own
      assert.match(r.stdout, /loop: batch of 2 — fx-a \+ fx-b/);
      assert.match(r.stdout, /loop: fx-a, fx-b → PR/);
      assert.match(r.stdout, /loop: fx-c → PR/);
      assert.doesNotMatch(r.stdout, /batch of 3/);
      assert.match(r.stdout, /fx-a, fx-b landed/);
      // the tally counts work ITEMS (gate members) — the clump is one
      assert.match(r.stdout, /2 landed, 0 closed, 0 parked, 0 failed/);
      // two worker spawns total — the clump's one plus fx-c's solo —
      // and two PRs, not three. Spawn order between detached workers is
      // a race, so assert the SET, not the sequence
      const evs = (readHostState(f.hostState).events ?? []) as Array<Record<string, unknown>>;
      const works = evs.filter(e => e.spawn !== undefined);
      assert.equal(works.length, 2);
      const clump = works.find(w => w.spawn === 'fx-a');
      const solo = works.find(w => w.spawn === 'fx-c');
      assert.equal(clump?.ids, 'fx-a,fx-b');
      assert.equal(solo?.ids, 'fx-c');
      assert.equal(Object.keys(readHostState(f.hostState).prs as object).length, 2);
      // coverage close: the commits named both members
      assertLandedBead(f.db, 'fx-a');
      assertLandedBead(f.db, 'fx-b');
      assertLandedBead(f.db, 'fx-c');
      // the watch marker carried the whole clump — a dead loop's rearm
      // discharges every member, not just the lead (bro-q6ppv + nspj7)
      const peeks = (readHostState(f.hostState).watchPeeks ?? []) as Array<{
        marker: { pr: number; bead?: string };
      }>;
      assert.ok(
        peeks.some(p => p.marker.bead === 'fx-a,fx-b'),
        'no watch marker carried the clump ids'
      );
    });
  });

  test('batch partial: a member the commits never named re-queues on merge', () => {
    // fail-safe by construction — the gate closes only what the
    // branch's commit log proves; the unfinished tail re-queues
    const f = loopFixture(cliDebtPair(), { batch: 4 }, 'batch-partial');
    writeHostState(f.hostState, { prs: {} });
    inside(f.main, f.root, () => {
      const r = f.run();
      assert.match(r.stdout, /loop: batch of 2 — fx-a \+ fx-b/);
      assert.match(r.stdout, /fx-b not covered .* re-queued/);
      assertLandedBead(f.db, 'fx-a');
      const tail = bead(f.db, 'fx-b');
      // open again — claimed by the run, released on merge, never
      // falsely closed; a later run re-picks it (seen-beads don't
      // reclaim inside the same run)
      assert.equal(tail?.status, 'open');
      assert.match(String(tail?.notes), /landed without a commit naming fx-b/);
    });
  });

  test('--batch never clumps a P1 lead or a keyless queue', () => {
    // the floor is a hard gate: a P1 lead binds nothing even when
    // same-keyed P3s sit behind it — and keyless beads never match
    const f = loopFixture(
      [
        { ...FAKE_BEAD, id: 'fx-a', title: 'urgent fix', priority: 1, labels: ['area:cli'] },
        { ...FAKE_BEAD, id: 'fx-b', title: 'cli drift 1', priority: 3, labels: ['area:cli'] },
        { ...FAKE_BEAD, id: 'fx-c', title: 'cli drift 2', priority: 3, labels: ['area:cli'] },
        { ...FAKE_BEAD, id: 'fx-d', title: 'misc chore', priority: 3 },
        { ...FAKE_BEAD, id: 'fx-e', title: 'another chore', priority: 3 },
      ],
      {},
      'batch'
    );
    writeHostState(f.hostState, { prs: {} });
    inside(f.main, f.root, () => {
      const r = f.run(['--batch', '4']);
      // P1 lead claims solo even with batch on …
      assert.match(r.stdout, /loop: fx-a → PR/);
      assert.doesNotMatch(r.stdout, /batch of \d+ — fx-a/);
      // … the P3 area pair clumps under its own lead …
      assert.match(r.stdout, /loop: batch of 2 — fx-b \+ fx-c/);
      // … and the keyless chores claim one at a time
      assert.match(r.stdout, /loop: fx-d → PR/);
      assert.match(r.stdout, /loop: fx-e → PR/);
      // 5 beads in 4 work items — the clump is one landed item
      assert.match(r.stdout, /4 landed, 0 closed, 0 parked, 0 failed/);
      const evs = (readHostState(f.hostState).events ?? []) as Array<Record<string, unknown>>;
      assert.equal(evs.filter(e => e.spawn !== undefined).length, 4);
    });
  });

  test('close-out reaps leftover loop litter — clean closed-bead trees, keeps dirty', () => {
    // the incident shape: earlier runs left loop worktrees behind and
    // the audit listed them without removing them
    const f = loopFixture([
      { ...FAKE_BEAD, id: 'fx-a', title: 'ship it' },
      { ...FAKE_BEAD, id: 'fx-z', title: 'landed earlier', status: 'closed' },
      { ...FAKE_BEAD, id: 'fx-y', title: 'closed but dirty', status: 'closed' },
    ]);
    // a clean orphan on a closed bead — must be reaped …
    const orphan = join(f.root, 'main--fx-z');
    git(['worktree', 'add', '-b', 'loop/fx-z', orphan], f.main);
    // … and a dirty one — must be kept and still named as a tail
    const dirty = join(f.root, 'main--fx-y');
    git(['worktree', 'add', '-b', 'loop/fx-y', dirty], f.main);
    writeFileSync(join(dirty, 'wip.txt'), 'uncommitted\n');
    // a per-branch PR map makes fx-a's lookup land while the orphans
    // read as PR-less — the map is authoritative in the fake host
    writeHostState(f.hostState, {
      prs: { 'loop/fx-a': { number: 7, state: 'OPEN', headRef: 'loop/fx-a', baseRef: 'main' } },
    });
    inside(f.main, f.root, () => {
      const r = f.run();
      assert.match(r.stdout, /loop: fx-a landed/);
      assert.match(r.stdout, /reaped: .*main--fx-z \[loop\/fx-z\]/);
      assert.match(r.stdout, /deleted branch: loop\/fx-z/);
      assert.equal(existsSync(orphan), false);
      assert.equal(git(['branch', '--list', 'loop/fx-z'], f.main).trim(), '');
      // the dirty tree stays — a surviving tail, not a silent sweep
      assert.equal(existsSync(dirty), true);
      assert.match(r.stdout, /worktrees: .*main--fx-y \[loop\/fx-y\]/);
    });
  });
});

/** The liveness contract (spec bro-snga4) — verified against a running
 *  loop, not spawnSync's finished result: a hung agent must stall the
 *  loop visibly (heartbeat lines name the stage), and a mid-run exit
 *  must audit itself. `inside` isn't used — it reaps the fixture root
 *  synchronously while the spawned CLI still runs. */
describe('bro loop liveness', () => {
  const spawnLoop = (f: Fixture, extra: string[] = []) =>
    spawn(process.execPath, [CLI_DIST, 'loop', ...extra], {
      cwd: f.main,
      env: e2eEnv({
        PATH: `${join(f.root, 'bin')}:${process.env.PATH ?? ''}`,
        HOME: f.root,
        FAKE_BD_DB: f.db,
        FAKE_HOST_STATE: f.hostState,
        E2E_SCENARIO: 'hang',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  const until = async (fn: () => boolean, what: string): Promise<void> => {
    const deadline = Date.now() + 20_000;
    while (!fn()) {
      assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
      await new Promise(r => setTimeout(r, 50));
    }
  };

  test('a hung agent stalls visibly — heartbeat names the stage, SIGTERM exits audited', async () => {
    const f = loopFixture([{ ...FAKE_BEAD, id: 'fx-a', title: 'hangs' }], {}, 'hang');
    const proc = spawnLoop(f, ['--interval', '0.1']);
    let stderr = '';
    proc.stderr!.on('data', (d: Buffer) => (stderr += d));
    let workerPid = 0;
    try {
      // the heartbeat holds the event loop open — a drain-shaped death
      // would have ended the process before any `alive` line; the line
      // names the suspension point the silent deaths hid (now the
      // registry agent id + pid — bro-zpa93)
      await until(
        () => /loop: alive — worker \S+ pid=\d+ on fx-a/.test(stderr),
        'a worker-stage heartbeat'
      );
      assert.equal(proc.exitCode, null, 'the loop died awaiting the hung agent');
      workerPid = Number(/worker \S+ pid=(\d+)/.exec(stderr)![1]);
      proc.kill('SIGTERM');
      // the audit re-raises — the parent still sees a real signal
      // death, not a clean exit code
      const [code, signal] = await new Promise<[number | null, string | null]>(r =>
        proc.once('exit', (c, s) => r([c, s]))
      );
      assert.equal(signal, 'SIGTERM');
      assert.equal(code, null);
      // the signal handler audits before re-raising — stage + bead
      // named, the note landed, exactly what the silent deaths denied
      assert.match(stderr, /exiting mid-run — worker \S+ pid=\d+ on fx-a/);
      assert.match(String(bead(f.db, 'fx-a')?.notes), /process exited mid-run/);
    } finally {
      // a failed wait must not leave the loop or the detached agent
      // group running — reap both before the fixture goes, or the
      // child's open pipes hang the test run
      proc.kill('SIGKILL');
      const pid = workerPid || Number(/worker \S+ pid=(\d+)/.exec(stderr)?.[1] ?? 0);
      if (pid !== 0) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
      // a fork-style scope would name the payload under a pid the log
      // never saw — the handles cover either topology (bro-ybo8z)
      killRunHandles(f.main);
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});

/** Fixture presets for the provider-lane tests — `agent: 'false'` in
 *  loopCfg proves the provider's command ran, not the template. */
const SHIP_IT = [{ ...FAKE_BEAD, id: 'fx-a', title: 'ship it' }];

const cliLane = (loopCfg: Record<string, unknown> = {}): Fixture =>
  loopFixture(SHIP_IT, { agent: 'false', ...loopCfg }, 'land', host => ({
    providers: { fakecli: { type: 'cli', command: `node ${host.agent}` } },
  }));

const acpLane = (
  loopCfg: Record<string, unknown>,
  devin: Record<string, unknown> = {},
  extra: Record<string, unknown> = {}
): Fixture =>
  loopFixture(SHIP_IT, loopCfg, 'land', () => ({
    providers: { devin: { type: 'acp', command: 'devin acp', ...devin } },
    ...extra,
  }));

describe('bro loop provider lane', () => {
  test('loop.provider config routes the spawn — loop.agent is not consulted', () => {
    // loop.agent would fail (`false`) — the provider's command must win
    const f = cliLane({ provider: 'fakecli' });
    inside(f.main, f.root, () => {
      const r = f.run();
      assert.match(r.stdout, /loop: fx-a landed/);
      assert.match(spawns(f), /work opened pr/);
      assert.equal(bead(f.db, 'fx-a')?.status, 'closed');
    });
  });

  test('--provider <name> routes the spawn through the registry', () => {
    const f = cliLane();
    inside(f.main, f.root, () => {
      const r = f.run(['--provider', 'fakecli']);
      assert.match(r.stdout, /loop: fx-a landed/);
      assert.match(spawns(f), /work opened pr/);
    });
  });

  test('--agent <provider-name> names the provider, not a template', () => {
    const f = cliLane();
    inside(f.main, f.root, () => {
      const r = f.run(['--agent', 'fakecli']);
      assert.match(r.stdout, /loop: fx-a landed/);
    });
  });

  test('acp provider spawns the headless acp-worker argv — no shell template', () => {
    const f = acpLane({ agent: 'false' }, { model: 'swe-2', autoApprove: true });
    installFakeBro(f.root);
    inside(f.main, f.root, () => {
      const r = f.run(['--agent', 'devin']);
      assert.match(r.stdout, /loop: fx-a landed/, r.stderr);
      const log = readFileSync(join(f.main, 'acpworker.log'), 'utf8').trim();
      const rec = JSON.parse(log) as {
        args: string[];
        promptFile: string;
        promptOk: boolean;
        bead: string;
        provider: string;
        agent: string;
        model: string;
        batch: string | null;
      };
      // `bro acp-worker --command <cmd> --model <m> --auto-approve <pf>`
      assert.equal(rec.args[0], 'acp-worker');
      assert.deepEqual(rec.args.slice(1, -1), [
        '--command',
        'devin acp',
        '--model',
        'swe-2',
        '--auto-approve',
      ]);
      assert.equal(rec.promptOk, true, `prompt file ${rec.promptFile} missing`);
      assert.equal(rec.bead, 'fx-a');
      // provenance pins: provider lane identity, agent cli badge
      assert.equal(rec.provider, 'devin');
      // the batch marker rides on EVERY loop spawn — a root bead has no
      // molecule parent, so the fleet's own budget must still see it
      assert.equal(rec.batch, '1');
      assert.equal(rec.agent, 'devin');
      assert.equal(rec.model, 'swe-2');
      assert.equal(bead(f.db, 'fx-a')?.status, 'closed');
    });
  });

  test('--profile <name> fills provider/model/autoApprove piecewise', () => {
    const f = acpLane(
      { agent: 'false' },
      {},
      { fleet: { profiles: { cheap: { provider: 'devin', model: 'swe-1.5', autoApprove: true } } } }
    );
    installFakeBro(f.root);
    inside(f.main, f.root, () => {
      const r = f.run(['--profile', 'cheap']);
      assert.match(r.stdout, /loop: fx-a landed/, r.stderr);
      const rec = JSON.parse(readFileSync(join(f.main, 'acpworker.log'), 'utf8').trim()) as {
        args: string[];
        model: string;
      };
      assert.equal(rec.args.includes('--auto-approve'), true);
      assert.equal(rec.model, 'swe-1.5');
    });
  });

  test('a template --agent overrides a configured loop.provider (escape hatch)', () => {
    const f = loopFixture(SHIP_IT, { provider: 'bad' }, 'land', () => ({
      providers: { bad: { type: 'cli', command: 'false' } },
    }));
    inside(f.main, f.root, () => {
      const r = f.run(['--agent', `node ${f.agent}`]);
      assert.match(r.stderr, /bypasses the configured provider lane/);
      assert.match(r.stdout, /loop: fx-a landed/);
    });
  });

  test('an unknown --provider fails before any bead is claimed', () => {
    const f = loopFixture(SHIP_IT);
    inside(f.main, f.root, () => {
      const r = f.run(['--provider', 'nope']);
      assert.equal(r.code, 2);
      assert.match(r.stderr, /providers\.nope is not configured/);
      assert.equal(bead(f.db, 'fx-a')?.status, 'open');
    });
  });

  test('--agent <provider> and a disagreeing --provider is a usage error', () => {
    const f = loopFixture([], {}, 'land', () => ({
      providers: {
        a: { type: 'cli', command: 'a-cmd' },
        b: { type: 'cli', command: 'b-cmd' },
      },
    }));
    inside(f.main, f.root, () => {
      const r = f.run(['--agent', 'a', '--provider', 'b']);
      assert.equal(r.code, 2);
      assert.match(r.stderr, /different providers/);
    });
  });

  test('provider flags beside a template --agent are contradictory', () => {
    const f = loopFixture([], {}, 'land', () => ({
      providers: { fakecli: { type: 'cli', command: 'node x' } },
    }));
    inside(f.main, f.root, () => {
      const r = f.run(['--agent', 'node x {promptFile}', '--model', 'm-1']);
      assert.equal(r.code, 2);
      assert.match(r.stderr, /raw template/);
    });
  });

  test('--model with no provider configured is refused, not dropped', () => {
    const f = loopFixture([]);
    inside(f.main, f.root, () => {
      const r = f.run(['--model', 'm-1']);
      assert.equal(r.code, 2);
      assert.match(r.stderr, /ride the provider lane/);
    });
  });

  test('--dry-run renders the resolved provider + acp-worker argv', () => {
    const f = acpLane({});
    inside(f.main, f.root, () => {
      const r = f.run(['--agent', 'devin', '--dry-run']);
      assert.match(r.stdout, /would claim fx-a/);
      assert.match(r.stdout, /provider: devin/);
      assert.match(r.stdout, /acp-worker/);
      assert.match(r.stdout, /--command 'devin acp'/);
      assert.equal(bead(f.db, 'fx-a')?.status, 'open');
    });
  });
});

/** Routing fixture — two cli providers over the same fake agent, a
 *  `default` chain and a `sweep` chain. loop.agent is 'false' so only a
 *  provider command can land anything. */
const routedLane = (
  rows: Array<Record<string, unknown>>,
  loopCfg: Record<string, unknown> = {},
  routing: Record<string, unknown> = {
    default: { chain: ['regular'] },
    sweep: { chain: ['sweeper'] },
  }
): Fixture =>
  loopFixture(rows, { agent: 'false', ...loopCfg }, 'land', host => ({
    providers: {
      sweeper: { type: 'cli', command: `node ${host.agent}` },
      regular: { type: 'cli', command: `node ${host.agent}` },
    },
    fleet: { routing },
  }));

describe('bro loop fleet.routing', () => {
  test('each bead resolves its class — the class: label and default pick different providers', () => {
    const f = routedLane([
      { ...FAKE_BEAD, id: 'fx-a', title: 'sweep the queue', labels: ['class:sweep'] },
      { ...FAKE_BEAD, id: 'fx-b', title: 'plain work' },
    ]);
    // per-branch PR map — both beads get their own PR number
    writeHostState(f.hostState, { prs: {} });
    inside(f.main, f.root, () => {
      const r = f.run();
      assert.match(r.stdout, /fleet\.routing — provider resolves per bead class/);
      assert.match(r.stdout, /2 landed, 0 closed, 0 parked, 0 failed/, r.stderr);
      const log = spawns(f);
      assert.match(log, /work opened pr \[bead=fx-a provider=sweeper class=sweep\]/);
      assert.match(log, /work opened pr \[bead=fx-b provider=regular class=default\]/);
      assert.equal(bead(f.db, 'fx-a')?.status, 'closed');
      assert.equal(bead(f.db, 'fx-b')?.status, 'closed');
    });
  });

  test('--class pins the lane — a disagreeing class: label loses to the flag', () => {
    const f = routedLane([{ ...FAKE_BEAD, id: 'fx-a', title: 'pin me', labels: ['class:nope'] }]);
    inside(f.main, f.root, () => {
      const r = f.run(['--class', 'sweep']);
      assert.match(r.stdout, /loop: fx-a landed/, r.stderr);
      assert.match(spawns(f), /work opened pr \[bead=fx-a provider=sweeper class=sweep\]/);
    });
  });

  test('an unknown --class fails before the first claim', () => {
    const f = routedLane([{ ...FAKE_BEAD, id: 'fx-a', title: 'ship it' }]);
    inside(f.main, f.root, () => {
      const r = f.run(['--class', 'bogus']);
      assert.equal(r.code, 2);
      assert.match(r.stderr, /fleet\.routing has no class "bogus"/);
      assert.equal(bead(f.db, 'fx-a')?.status, 'open');
    });
  });

  test('a missing default row fails before the first claim', () => {
    const f = routedLane(
      [{ ...FAKE_BEAD, id: 'fx-a', title: 'ship it' }],
      {},
      { sweep: { chain: ['sweeper'] } }
    );
    inside(f.main, f.root, () => {
      const r = f.run();
      assert.equal(r.code, 2);
      assert.match(r.stderr, /fleet\.routing has no class "default"/);
      assert.equal(bead(f.db, 'fx-a')?.status, 'open');
    });
  });

  test('a dead loop.provider under armed routing cannot abort the run', () => {
    // 'ghost' is never configured — under routing every bead takes its
    // class chain head, so the stale lower-tier pick is unreachable and
    // must not fail the run before the first claim
    const f = routedLane([{ ...FAKE_BEAD, id: 'fx-a', title: 'ship it' }], { provider: 'ghost' });
    inside(f.main, f.root, () => {
      const r = f.run();
      assert.match(r.stdout, /loop: fx-a landed/, r.stderr);
      assert.equal(bead(f.db, 'fx-a')?.status, 'closed');
    });
  });

  test('an unknown class: label parks the bead — claimed and noted, no worktree litter', () => {
    const f = routedLane([
      { ...FAKE_BEAD, id: 'fx-a', title: 'misrouted', labels: ['class:bogus'] },
    ]);
    inside(f.main, f.root, () => {
      const r = f.run();
      assert.match(r.stdout, /1 parked/, r.stderr);
      assert.match(r.stdout, /route failed — .*no class "bogus"/);
      const row = bead(f.db, 'fx-a');
      assert.equal(row?.status, 'in_progress');
      assert.match(String(row?.notes), /route resolution failed.*no class "bogus"/);
      assert.equal(existsSync(f.worktree), false);
    });
  });

  test('a pinned provider still pins every bead — the class rides as provenance', () => {
    // --agent <provider> stays the single-provider bypass: every bead
    // lands on the pinned lane, but the resolved class still stamps
    const f = routedLane(
      [
        { ...FAKE_BEAD, id: 'fx-a', title: 'sweep', labels: ['class:sweep'] },
        { ...FAKE_BEAD, id: 'fx-b', title: 'plain' },
      ],
      {}
    );
    writeHostState(f.hostState, { prs: {} });
    inside(f.main, f.root, () => {
      const r = f.run(['--provider', 'regular']);
      assert.match(r.stdout, /2 landed/, r.stderr);
      const log = spawns(f);
      assert.match(log, /work opened pr \[bead=fx-a provider=regular class=sweep\]/);
      assert.match(log, /work opened pr \[bead=fx-b provider=regular class=default\]/);
    });
  });

  test('a template --agent bypasses fleet.routing with a warn line', () => {
    const f = routedLane([{ ...FAKE_BEAD, id: 'fx-a', title: 'ship it' }]);
    inside(f.main, f.root, () => {
      const r = f.run(['--agent', `node ${f.agent}`]);
      assert.match(r.stderr, /bypasses fleet\.routing/);
      assert.match(r.stdout, /loop: fx-a landed/);
      assert.match(spawns(f), /work opened pr \[bead=fx-a provider=- class=-\]/);
    });
  });

  test('--class beside a template --agent is contradictory', () => {
    const f = routedLane([]);
    inside(f.main, f.root, () => {
      const r = f.run(['--agent', 'raw -p {promptFile}', '--class', 'sweep']);
      assert.equal(r.code, 2);
      assert.match(r.stderr, /raw template/);
    });
  });

  test('--dry-run renders the claimed bead’s resolved class + provider', () => {
    const f = routedLane([
      { ...FAKE_BEAD, id: 'fx-a', title: 'sweep it', labels: ['class:sweep'] },
    ]);
    inside(f.main, f.root, () => {
      const r = f.run(['--dry-run']);
      assert.match(r.stdout, /would claim fx-a/);
      assert.match(r.stdout, /class: sweep/);
      assert.match(r.stdout, /provider: sweeper/);
      assert.equal(bead(f.db, 'fx-a')?.status, 'open');
    });
  });
});

/** Provider-wall settle (bro-36bhc) — the loop honors the exit-cause
 *  taxonomy the registry records instead of respawning into the wall:
 *  a rate_limited death with a provider reset parks until the reset
 *  (then wakes and respawns), a death/wall with no advertised end parks
 *  loud, and spawn admission into a derived wall holds pushes until
 *  the reset instead of re-claiming every interval. The cli provider
 *  lane is required — a raw template spawn carries no `provider` the
 *  derived wall can be attributed to. */
describe('bro loop provider walls (bro-36bhc)', () => {
  const walledLane = (loopCfg: Record<string, unknown> = {}): Fixture =>
    cliLane({ provider: 'fakecli', ...loopCfg });

  /** Seed a classified death straight into the agents registry — the
   *  same record a real worker's exit harvest writes (cause/resetAt/
   *  provider all ride the entry; spec bro-1x7p derives walls from
   *  exactly this). */
  const seedDeath = (f: Fixture, patch: Record<string, unknown>): void => {
    const dir = join(f.main, '.git', 'bro');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'agents.json'),
      JSON.stringify({
        'fx-prev': {
          agentId: 'native-prevdead',
          backend: 'native',
          spawnedAt: new Date(Date.now() - 60_000).toISOString(),
          exitStatus: 1,
          provider: 'fakecli',
          ...patch,
        },
      })
    );
  };

  test('a rate_limited worker parks until the provider reset — then wakes and lands', () => {
    // the incident fix: the park's snooze is the wall's own clock, not
    // the flat 2h cooldown. The epoch reset form is absolute — the
    // defer stamp equals it exactly, whenever the harvest runs. A
    // far-future reset keeps run 1 deterministic on a slow CI; the
    // wake half then simulates the clock passing rather than sleeping
    // it out.
    const f = walledLane();
    inside(f.main, f.root, () => {
      const reset = Math.floor(Date.now() / 1000) + 5400;
      const resetIso = new Date(reset * 1000).toISOString();
      writeHostState(f.hostState, {
        walls: {
          'fx-a': { tail: `API rate limit exceeded — x-ratelimit-reset: ${reset}`, exit: 1 },
        },
      });
      const r = f.run();
      assert.match(r.stdout, /1 parked/, r.stderr);
      const row = bead(f.db, 'fx-a');
      assert.equal(row?.status, 'deferred');
      assert.equal(row?.defer_until, resetIso);
      assert.match(String(row?.notes), /blocked \(rate_limited\) til /);
      // one spawn total — the worker that died; nothing churned
      assert.equal(spawns(f).trim().split('\n').length, 1);
      // the wall lifts: the snooze's due stamp wakes on the next ready
      // read, and the recorded death is operator-cleared (`bro agents
      // down` writes the same stopped flag — spec bro-1x7p)
      const db = JSON.parse(readFileSync(f.db, 'utf8')) as {
        rows: Array<Record<string, unknown>>;
      };
      db.rows.find(r2 => r2.id === 'fx-a')!.defer_until = new Date(
        Date.now() - 60_000
      ).toISOString();
      writeFileSync(f.db, JSON.stringify(db));
      const regPath = join(f.main, '.git', 'bro', 'agents.json');
      const reg = JSON.parse(readFileSync(regPath, 'utf8')) as Record<
        string,
        Record<string, unknown>
      >;
      reg['fx-a']!.stopped = true;
      writeFileSync(regPath, JSON.stringify(reg));
      const woke = f.run();
      assert.match(woke.stdout, /loop: fx-a landed/, woke.stderr);
      assert.equal(bead(f.db, 'fx-a')?.status, 'closed');
      assert.match(spawns(f), /work opened pr/);
    });
  });

  test('a rate_limited death with no reported reset takes the flat cooldown', () => {
    // no reset on the tail = a wall with no advertised end — a timed
    // wait would invent a horizon the provider never gave
    const f = walledLane();
    writeHostState(f.hostState, {
      walls: { 'fx-a': { tail: 'HTTP 429 too many requests', exit: 1 } },
    });
    inside(f.main, f.root, () => {
      const r = f.run();
      assert.match(r.stdout, /1 parked/, r.stderr);
      const row = bead(f.db, 'fx-a');
      assert.equal(row?.status, 'deferred');
      assert.match(String(row?.notes), /blocked \(rate_limited\)/);
      assert.doesNotMatch(String(row?.notes), /til /);
      const wake = Date.parse(String(row?.defer_until));
      assert.ok(
        wake > Date.now() + 60 * 60_000,
        `no-reset wall should take the parkedWakeMin cooldown — defer_until ${String(row?.defer_until)}`
      );
      assert.equal(spawns(f).trim().split('\n').length, 1);
    });
  });

  test('a quota death parks the same way — an operator clears it, not a timer', () => {
    const f = walledLane();
    writeHostState(f.hostState, {
      walls: { 'fx-a': { tail: 'insufficient credits — usage limit exceeded', exit: 1 } },
    });
    inside(f.main, f.root, () => {
      const r = f.run();
      assert.match(r.stdout, /1 parked/, r.stderr);
      const row = bead(f.db, 'fx-a');
      assert.equal(row?.status, 'deferred');
      assert.match(String(row?.notes), /blocked \(quota\)/);
      assert.equal(spawns(f).trim().split('\n').length, 1);
    });
  });

  test('a derived quota wall at spawn admission parks the clump — zero workers burned', () => {
    // a quota wall has no advertised end: the batch lane's refusal
    // settles as a park once, not the claim → refuse → re-claim churn
    // the bead reported
    const f = walledLane();
    seedDeath(f, { cause: 'quota' });
    inside(f.main, f.root, () => {
      const r = f.run();
      assert.match(r.stdout, /loop: fx-a parked — fakecli walled — quota/, r.stderr);
      assert.match(r.stdout, /1 parked/);
      const row = bead(f.db, 'fx-a');
      assert.equal(row?.status, 'deferred');
      assert.match(String(row?.notes), /fakecli walled — quota/);
      // the refusal landed before any worker existed — empty spawn ledger
      assert.equal(spawns(f), '');
    });
  });

  test('a rate_limited wall with no reset parks at admission too', () => {
    const f = walledLane();
    seedDeath(f, { cause: 'rate_limited' });
    inside(f.main, f.root, () => {
      const r = f.run();
      assert.match(r.stdout, /loop: fx-a parked — fakecli walled — rate_limited/, r.stderr);
      assert.match(r.stdout, /1 parked/);
      assert.equal(bead(f.db, 'fx-a')?.status, 'deferred');
      assert.equal(spawns(f), '');
    });
  });

  test('a timed wall at spawn admission holds pushes until the reset — no churn', () => {
    // the convoy wait contract at the admission edge: a reset the
    // provider reported is a horizon to wait, not a wall to park — the
    // claims release and pushes hold until it (same shape as the
    // disk-floor hold: non-terminating under the test's own timeout)
    const until = new Date(Date.now() + 45 * 60_000).toISOString();
    const f = walledLane();
    seedDeath(f, { cause: 'rate_limited', resetAt: until });
    inside(f.main, f.root, () => {
      const proc = spawnSync(process.execPath, [CLI_DIST, 'loop', '--interval', '0.1'], {
        cwd: f.main,
        env: e2eEnv(f.env),
        encoding: 'utf8',
        timeout: 4_000,
      });
      assert.equal(proc.status, null, 'run should hold pushes until the wall reset');
      const stdout = proc.stdout ?? '';
      assert.match(stdout, /fakecli walled — rate_limited til \S+ — pushes hold until the reset/);
      // exactly one hold — the wall's reset is the next probe, not a tick
      assert.equal(stdout.match(/pushes hold until the reset/g)?.length, 1);
      // nothing spawned, nothing claimed — the released claim sits open
      assert.equal(spawns(f), '');
      assert.equal(bead(f.db, 'fx-a')?.status, 'open');
    });
  });
});

describe('bro loop argv parse', () => {
  test('an unquoted --agent tail is rejected — never silently dropped', () => {
    // the incident shape: --agent devin -p --prompt-file {promptFile} …
    // must not degrade into a bare `devin <file>` interactive TUI
    const f = loopFixture([]);
    inside(f.main, f.root, () => {
      const r = f.run([
        '--agent',
        'devin',
        '-p',
        '--prompt-file',
        '{promptFile}',
        '--permission-mode',
        'dangerous',
      ]);
      assert.equal(r.code, 2);
      assert.match(r.stderr, /unknown option --prompt-file|unexpected argument/);
    });
  });

  test('the retired --agent-timeout fails closed — no kill path to arm', () => {
    const f = loopFixture([]);
    inside(f.main, f.root, () => {
      const r = f.run(['--agent-timeout', '5']);
      assert.equal(r.code, 2);
      assert.match(r.stderr, /unknown option --agent-timeout|unexpected argument/);
    });
  });

  test('a stray positional names itself and the quoting fix', () => {
    const f = loopFixture([]);
    inside(f.main, f.root, () => {
      const r = f.run(['bogus-token']);
      assert.equal(r.code, 2);
      assert.match(r.stderr, /unexpected argument 'bogus-token'/);
      assert.match(r.stderr, /--agent 'devin -p --prompt-file \{promptFile\}'/);
    });
  });

  test('an agent template without {promptFile} warns but still runs', () => {
    const f = loopFixture([]);
    inside(f.main, f.root, () => {
      const r = f.run(['--agent', 'devin']);
      assert.equal(r.code, 0);
      assert.match(r.stderr, /has no \{promptFile\}/);
      assert.match(r.stdout, /0 landed/);
    });
  });

  test('a bool flag carrying =value is refused — never a silent live run', () => {
    // --dry-run=true parses as the flag but argv.includes('--dry-run')
    // misses it — without the strict check the queue would run live
    const f = loopFixture([]);
    inside(f.main, f.root, () => {
      const r = f.run(['--dry-run=true']);
      assert.equal(r.code, 2);
      assert.match(r.stderr, /option --dry-run takes no value/);
    });
  });

  test('a value flag fed a flag token demands a real value', () => {
    const f = loopFixture([]);
    inside(f.main, f.root, () => {
      const r = f.run(['--agent', '--json']);
      assert.equal(r.code, 2);
      assert.match(r.stderr, /option --agent requires a value/);
    });
  });

  test('a quoted {promptFile} template parses clean', () => {
    const f = loopFixture([]);
    inside(f.main, f.root, () => {
      const r = f.run(['--agent', 'devin -p --prompt-file {promptFile}']);
      assert.equal(r.code, 0);
      assert.match(r.stdout, /0 landed/);
      assert.doesNotMatch(r.stderr, /has no \{promptFile\}/);
    });
  });
});

/** Two-bead fixtures seed `prs: {}` so the per-branch map is
 *  authoritative — the agent registers each loop branch's PR as it
 *  "opens" it (nextPr counts up from 11). */
const events = (f: Fixture): Array<Record<string, unknown>> =>
  (readHostState(f.hostState).events ?? []) as Array<Record<string, unknown>>;

describe('bro loop gate-stack round-robin', () => {
  test('a long first worker does not starve the stack — B lands inside A\u2019s worker window', () => {
    // the starvation shape bro-zpa93 fixes: pushItem used to await the
    // whole worker run inside the tick — B could not even claim while
    // A ran. Now A's worker rides a pending member and the tick keeps
    // servicing the rest: B's spawn AND merge land while A's agent is
    // still inside its deliberate delay — an ordering the awaited-spawn
    // shape made impossible.
    const f = loopFixture([
      { ...FAKE_BEAD, id: 'fx-a', title: 'slow worker' },
      { ...FAKE_BEAD, id: 'fx-b', title: 'fast worker' },
    ]);
    writeHostState(f.hostState, { prs: {}, delays: { 'fx-a': 5000 } });
    inside(f.main, f.root, () => {
      const r = f.run();
      assert.match(r.stdout, /2 landed/, r.stderr);
      const prs = readHostState(f.hostState).prs as Record<string, { number: number }>;
      const a = prs['loop/fx-a']!.number;
      const b = prs['loop/fx-b']!.number;
      assert.deepEqual(events(f), [
        { spawn: 'fx-b', branch: 'loop/fx-b' },
        // B's whole pipeline — spawn, PR, merge — settled inside A's
        // worker window: the `spawn` event is stamped by the agent at
        // run time, so A's entry only lands once its delay ends
        { merge: b },
        { spawn: 'fx-a', branch: 'loop/fx-a' },
        { merge: a },
      ]);
      assert.equal(bead(f.db, 'fx-a')?.status, 'closed');
      assert.equal(bead(f.db, 'fx-b')?.status, 'closed');
    });
  });

  test('a pending gate does not block the next claim — B lands while A waits', () => {
    const f = loopFixture([
      { ...FAKE_BEAD, id: 'fx-a', title: 'slow gate' },
      { ...FAKE_BEAD, id: 'fx-b', title: 'fast gate' },
    ]);
    // A is pending until B's PR (12 — A takes 11) merges
    writeHostState(f.hostState, {
      prs: {
        'loop/fx-a': {
          checks: [{ name: 'ci', bucket: 'pending', state: 'IN_PROGRESS' }],
          clearAfterMerge: 12,
        },
      },
    });
    inside(f.main, f.root, () => {
      const r = f.run();
      assert.match(r.stdout, /2 landed/, r.stderr);
      assert.deepEqual(events(f), [
        { spawn: 'fx-a', branch: 'loop/fx-a' },
        { spawn: 'fx-b', branch: 'loop/fx-b' },
        // B's gate settles first — the whole point: A's pending window
        // is claimed work, not orchestrator idle
        { merge: 12 },
        { merge: 11 },
      ]);
      assert.equal(bead(f.db, 'fx-a')?.status, 'closed');
      assert.equal(bead(f.db, 'fx-b')?.status, 'closed');
    });
  });

  test('--max-open 1 bounds the open-PR set — B spawns only after A lands', () => {
    const f = loopFixture(
      [
        { ...FAKE_BEAD, id: 'fx-a', title: 'first' },
        { ...FAKE_BEAD, id: 'fx-b', title: 'second' },
      ],
      { maxOpen: 1 }
    );
    writeHostState(f.hostState, { prs: {} });
    inside(f.main, f.root, () => {
      const r = f.run();
      assert.match(r.stdout, /2 landed/, r.stderr);
      assert.deepEqual(events(f), [
        { spawn: 'fx-a', branch: 'loop/fx-a' },
        { merge: 11 },
        { spawn: 'fx-b', branch: 'loop/fx-b' },
        { merge: 12 },
      ]);
    });
  });

  test('CONFLICTING respawns the agent with a rebase order, then lands', () => {
    const f = loopFixture([{ ...FAKE_BEAD, id: 'fx-a', title: 'conflicted' }]);
    writeHostState(f.hostState, {
      prs: { 'loop/fx-a': { mergeable: 'CONFLICTING' } },
    });
    inside(f.main, f.root, () => {
      const r = f.run();
      assert.match(r.stdout, /rebase round 1 onto main/, r.stderr);
      assert.match(r.stdout, /loop: fx-a landed/);
      assert.deepEqual(events(f), [
        { spawn: 'fx-a', branch: 'loop/fx-a' },
        { rebase: 'fx-a', branch: 'loop/fx-a' },
        { merge: 11 },
      ]);
      assert.match(spawns(f), /rebase rebased onto base/);
    });
  });

  test('BEHIND sole blocker pushes update-branch, then lands', () => {
    const f = loopFixture([{ ...FAKE_BEAD, id: 'fx-a', title: 'behind' }]);
    writeHostState(f.hostState, {
      prs: { 'loop/fx-a': { mergeState: 'BEHIND' } },
    });
    inside(f.main, f.root, () => {
      const r = f.run();
      assert.match(r.stdout, /loop: fx-a landed/);
      assert.deepEqual(events(f), [
        { spawn: 'fx-a', branch: 'loop/fx-a' },
        { update: 11 },
        { merge: 11 },
      ]);
    });
  });

  test('a parked member snoozes its claim — worktree + note survive the run', () => {
    const f = loopFixture([{ ...FAKE_BEAD, id: 'fx-a', title: 'red ci' }]);
    writeHostState(f.hostState, {
      prs: {
        'loop/fx-a': {
          checks: [{ name: 'ci', bucket: 'fail', state: 'FAILURE' }],
        },
      },
    });
    inside(f.main, f.root, () => {
      const r = f.run();
      assert.match(r.stdout, /1 parked/);
      const row = bead(f.db, 'fx-a');
      assert.equal(row?.status, 'deferred');
      assert.match(String(row?.notes), /blocked: 1 failing check\(s\)/);
    });
  });

  test('a bead whose snooze expired wakes on the ready read and lands (bro-hl22w)', () => {
    // the other half of the snooze contract: a deferred bead past its
    // defer_until is undeferred by the next ready-front read, claimed
    // like any open bead, and lands through the normal pipeline
    const f = loopFixture([
      {
        ...FAKE_BEAD,
        id: 'fx-a',
        title: 'woken',
        status: 'deferred',
        defer_until: new Date(Date.now() - 60_000).toISOString(),
      },
    ]);
    inside(f.main, f.root, () => {
      const r = f.run();
      assert.match(r.stdout, /loop: fx-a landed/);
      assert.equal(bead(f.db, 'fx-a')?.status, 'closed');
    });
  });

  test('a woken park whose branch already gates on a PR re-attaches — no re-spawn (bro-hl22w)', () => {
    // the claim-side half of the park contract: the snoozed bead kept
    // its worktree AND the open PR the earlier run pushed. The wake
    // must rejoin that gate — re-running the finished work order would
    // redo landed work and shove a duplicate push at the same PR
    const f = loopFixture([
      {
        ...FAKE_BEAD,
        id: 'fx-a',
        title: 'woken',
        status: 'deferred',
        defer_until: new Date(Date.now() - 60_000).toISOString(),
      },
    ]);
    // what the park left behind: the worktree, its branch's covering
    // commit, and the PR gating on it
    git(['worktree', 'add', '-b', 'loop/fx-a', f.worktree], f.main);
    git(['-C', f.worktree, 'commit', '-q', '--allow-empty', '-m', 'fix: fx-a work (fx-a)'], f.main);
    const head = git(['-C', f.worktree, 'rev-parse', 'HEAD'], f.main).trim();
    writeHostState(f.hostState, {
      prs: {
        'loop/fx-a': {
          number: 7,
          state: 'OPEN',
          headRef: 'loop/fx-a',
          baseRef: 'main',
          headSha: head,
        },
      },
    });
    inside(f.main, f.root, () => {
      const r = f.run();
      assert.match(r.stdout, /re-attaches to \[#7\]/);
      assert.match(r.stdout, /loop: fx-a landed/);
      // no worker ran — the reattach never reached the spawn
      const evs = (readHostState(f.hostState).events ?? []) as Array<Record<string, unknown>>;
      assert.equal(evs.filter(e => e.spawn !== undefined).length, 0);
      assert.equal(bead(f.db, 'fx-a')?.status, 'closed');
    });
  });
});
