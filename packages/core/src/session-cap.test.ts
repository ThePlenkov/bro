/** The host-wide session cap — the policy, vendor-blind (spec bro-bww9v).
 *
 *  The policy asks the plane registry: which kind would this command
 *  start a session of, how many, and how many are live. No vendor name
 *  appears here — the plane owns the grammar and the count.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SpawnError } from './agents.ts';
import { LockTimeout } from './filelock.ts';
import {
  clearSessionPlanes,
  countSessionReservations,
  registerSessionPlane,
  reserveSessionSlot,
  sessionAdmissionLock,
  type SessionPlane,
} from './session-planes.ts';
import {
  admitProviderSlot,
  admitSessionStart,
  planeStartingSessions,
  providerCapHeldRefusal,
  providerCapRefusal,
  providerSlotsKind,
  reserveSessionStart,
  sessionCapHeldRefusal,
  sessionCapRefusal,
  sessionCapRefusalFor,
  sessionCapViews,
} from './session-cap.ts';

/** The dir this file runs from — the child's .ts script imports the
 *  same sources by absolute path. */
const here = dirname(fileURLToPath(import.meta.url));

/** A plane that claims a command by a marker word and counts a
 *  scripted number of live sessions. `list` scripts per-pid rows —
 *  the exclusion the multiplexer census subtracts needs listLive. */
const testPlane = (
  kind: string,
  opts: { live?: number; starts?: number; fail?: boolean; list?: number[] } = {}
): SessionPlane => ({
  kind,
  detectsCli: cli => cli === `${kind}-cli`,
  startsSessions: command => (command.includes(`${kind}-run`) ? (opts.starts ?? 1) : 0),
  countLive: () => {
    if (opts.fail === true) {
      throw new SpawnError(`cannot count ${kind}`, 'unavailable');
    }
    return opts.live ?? 0;
  },
  ...(opts.list === undefined ? {} : { listLive: () => opts.list!.map(pid => ({ pid })) }),
});

const withPlane = (plane: SessionPlane, fn: () => void): void => {
  clearSessionPlanes();
  try {
    registerSessionPlane(plane);
    fn();
  } finally {
    clearSessionPlanes();
  }
};

/** A reservations dir the cap reads — the count includes what bro holds
 *  for in-flight starts. */
const withSlots = (fn: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), 'bro-cap-slots-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe('sessionCapViews', () => {
  test('a kind whose plane claims the command contributes a view', () => {
    withPlane(testPlane('alpha', { live: 2 }), () => {
      const views = sessionCapViews('alpha-run --now', {
        alpha: { maxSessions: 5, reservationsDir: '/nonexistent' },
      });
      assert.equal(views.length, 1);
      assert.equal(views[0]?.kind, 'alpha');
      assert.equal(views[0]?.live, 2);
      assert.equal(views[0]?.cap, 5);
      assert.equal(views[0]?.starts, 1);
    });
  });

  test('a command no plane claims contributes nothing', () => {
    withPlane(testPlane('alpha', { live: 9 }), () => {
      assert.deepEqual(sessionCapViews('other-thing', { alpha: { maxSessions: 1 } }), []);
    });
  });

  test('a kind with no cap armed contributes nothing', () => {
    withPlane(testPlane('alpha', { live: 9 }), () => {
      assert.deepEqual(sessionCapViews('alpha-run', { alpha: {} }), []);
      assert.deepEqual(sessionCapViews('alpha-run', { alpha: { maxSessions: 0 } }), []);
      assert.deepEqual(sessionCapViews('alpha-run', undefined), []);
    });
  });

  test('a plane without startsSessions never claims a command', () => {
    const plane: SessionPlane = {
      kind: 'alpha',
      detectsCli: () => true,
      countLive: () => 0,
    };
    withPlane(plane, () => {
      assert.deepEqual(sessionCapViews('alpha-run', { alpha: { maxSessions: 1 } }), []);
    });
  });

  test('reservations count with the live sessions', () => {
    withSlots(dir => {
      withPlane(testPlane('alpha', { live: 1 }), () => {
        const views = sessionCapViews('alpha-run', {
          alpha: { maxSessions: 5, reservationsDir: dir },
        });
        // no reservation files yet — the count is the live one
        assert.equal(views[0]?.live, 1);
        // a claimed slot (a start in flight) counts with it
        reserveSessionSlot(dir, 'alpha-guard', 'interactive');
        const claimed = sessionCapViews('alpha-run', {
          alpha: { maxSessions: 5, reservationsDir: dir },
        });
        assert.equal(claimed[0]?.live, 2);
      });
    });
  });

  test('excludePids leaves caller-owned live rows out of the count', () => {
    // a shared peer's deduped lock row is claim-covered already —
    // charging it again would count one session twice (spec bro-x601l)
    withPlane(testPlane('alpha', { live: 2, list: [10, 20] }), () => {
      const agents = { alpha: { maxSessions: 5, reservationsDir: '/nonexistent' } };
      assert.equal(sessionCapViews('alpha-run', agents)[0]?.live, 2);
      assert.equal(sessionCapViews('alpha-run', agents, undefined, new Set([20]))[0]?.live, 1);
      // an unlisted pid subtracts nothing; without listLive the count stands
      assert.equal(sessionCapViews('alpha-run', agents, undefined, new Set([99]))[0]?.live, 2);
    });
    withPlane(testPlane('alpha', { live: 2 }), () => {
      const agents = { alpha: { maxSessions: 5, reservationsDir: '/nonexistent' } };
      assert.equal(sessionCapViews('alpha-run', agents, undefined, new Set([10]))[0]?.live, 2);
    });
  });

  test('a malformed cap refuses — a typo is never an uncapped kind', () => {
    withPlane(testPlane('alpha', { live: 0 }), () => {
      assert.throws(
        () => sessionCapViews('alpha-run', { alpha: { maxSessions: 'six' } }),
        (err: unknown) => err instanceof SpawnError && err.kind === 'config'
      );
    });
  });

  test('an unverifiable count throws — the caller decides', () => {
    withPlane(testPlane('alpha', { fail: true }), () => {
      assert.throws(
        () => sessionCapViews('alpha-run', { alpha: { maxSessions: 5 } }),
        (err: unknown) => err instanceof SpawnError && err.kind === 'unavailable'
      );
    });
  });
});

describe('sessionCapRefusal', () => {
  test('a start that fits is allowed', () => {
    assert.equal(sessionCapRefusal({ kind: 'alpha', live: 2, cap: 3, starts: 1 }), undefined);
  });

  test('a start that would cross the cap is refused, with the numbers', () => {
    const refusal = sessionCapRefusal({ kind: 'alpha', live: 3, cap: 3, starts: 1 });
    assert.ok(refusal !== undefined);
    assert.match(refusal, /alpha/);
    assert.match(refusal, /3 live \+ 1 starting > 3/);
    assert.match(refusal, /agents\.alpha\.maxSessions/);
  });

  test('a command starting several sessions is judged against all of them', () => {
    // 1 live + 2 starting = 3 → fits a cap of 3
    assert.equal(sessionCapRefusal({ kind: 'alpha', live: 1, cap: 3, starts: 2 }), undefined);
    // 2 live + 2 starting = 4 → over a cap of 3
    const over = sessionCapRefusal({ kind: 'alpha', live: 2, cap: 3, starts: 2 });
    assert.ok(over !== undefined);
    assert.match(over, /2 live \+ 2 starting > 3/);
  });

  test('an uncapped kind is never refused', () => {
    assert.equal(sessionCapRefusal({ kind: 'alpha', live: 99, cap: 0, starts: 5 }), undefined);
  });
});

describe('sessionCapRefusalFor', () => {
  test('the first refusal among the kinds wins', () => {
    clearSessionPlanes();
    try {
      registerSessionPlane(testPlane('alpha', { live: 9 }));
      registerSessionPlane(testPlane('beta', { live: 9 }));
      const refusal = sessionCapRefusalFor('alpha-run beta-run', {
        alpha: { maxSessions: 1 },
        beta: { maxSessions: 1 },
      });
      assert.ok(refusal !== undefined);
      assert.match(refusal, /alpha/);
    } finally {
      clearSessionPlanes();
    }
  });
});

describe('planeStartingSessions', () => {
  test('the plane that claims the command is found', () => {
    withPlane(testPlane('alpha'), () => {
      assert.equal(planeStartingSessions('alpha-run')?.kind, 'alpha');
      assert.equal(planeStartingSessions('nope'), undefined);
    });
  });
});

describe('admitSessionStart', () => {
  test('a start below the cap is admitted and its slot claimed', () => {
    withSlots(dir => {
      const plane = testPlane('alpha', { live: 1 });
      withPlane(plane, () => {
        const admitted = admitSessionStart({
          plane,
          command: 'alpha-run',
          agents: { alpha: { maxSessions: 3, reservationsDir: dir } },
          key: 'call-1',
        });
        assert.ok(admitted !== undefined);
        assert.equal(admitted.refusal, undefined);
        assert.equal(admitted.fresh, true);
        // the claim landed — the next start sees it in the count
        assert.equal(countSessionReservations(dir), 1);
        assert.equal(admitted.paths.length, 1);
      });
    });
  });

  test('a burst shares one budget — the second start sees the first claim', () => {
    withSlots(dir => {
      const plane = testPlane('alpha', { live: 0 });
      withPlane(plane, () => {
        const bags = { alpha: { maxSessions: 1, reservationsDir: dir } };
        const first = admitSessionStart({
          plane,
          command: 'alpha-run',
          agents: bags,
          key: 'call-1',
        });
        assert.equal(first?.refusal, undefined);
        const second = admitSessionStart({
          plane,
          command: 'alpha-run',
          agents: bags,
          key: 'call-2',
        });
        assert.ok(second !== undefined);
        // post-claim census: the fresh claim is already inside live —
        // the strict held verdict names 2 held slots against cap 1
        assert.match(second.refusal ?? '', /alpha session quota reached — 2 live > 1/);
        // the refused claim was dropped — the budget holds only the admitted one
        assert.equal(countSessionReservations(dir), 1);
      });
    });
  });

  test('a repeat event of the same call claims no second slot and is judged once', () => {
    withSlots(dir => {
      const plane = testPlane('alpha', { live: 0 });
      withPlane(plane, () => {
        const bags = { alpha: { maxSessions: 1, reservationsDir: dir } };
        assert.equal(
          admitSessionStart({ plane, command: 'alpha-run', agents: bags, key: 'call-1' })?.refusal,
          undefined
        );
        // the second hook event of the same call: its earlier claim is
        // inside the count — judging starts again would double-count
        const repeat = admitSessionStart({
          plane,
          command: 'alpha-run',
          agents: bags,
          key: 'call-1',
        });
        assert.ok(repeat !== undefined);
        assert.equal(repeat.fresh, false);
        assert.equal(repeat.refusal, undefined);
        assert.equal(countSessionReservations(dir), 1);
      });
    });
  });

  test('extraLive counts sessions the caller holds that the plane cannot see', () => {
    withSlots(dir => {
      const plane = testPlane('alpha', { live: 0 });
      withPlane(plane, () => {
        const admitted = admitSessionStart({
          plane,
          command: 'alpha-run',
          agents: { alpha: { maxSessions: 2, reservationsDir: dir } },
          key: 'call-1',
          extraLive: 2,
        });
        // post-claim: 1 held claim + 2 extra live = 3 > 2
        assert.match(admitted?.refusal ?? '', /3 live > 2/);
      });
    });
  });

  test('a command the plane does not claim, or an unarmed cap, admits nothing', () => {
    const plane = testPlane('alpha', { live: 9 });
    withPlane(plane, () => {
      assert.equal(
        admitSessionStart({
          plane,
          command: 'other-thing',
          agents: { alpha: { maxSessions: 1 } },
          key: 'call-1',
        }),
        undefined
      );
      assert.equal(
        admitSessionStart({
          plane,
          command: 'alpha-run',
          agents: { alpha: {} },
          key: 'call-1',
        }),
        undefined
      );
    });
  });

  test('a malformed cap refuses config under the lock too', () => {
    const plane = testPlane('alpha', { live: 0 });
    withPlane(plane, () => {
      assert.throws(
        () =>
          admitSessionStart({
            plane,
            command: 'alpha-run',
            agents: { alpha: { maxSessions: 'six' } },
            key: 'call-1',
          }),
        (err: unknown) => err instanceof SpawnError && err.kind === 'config'
      );
    });
  });

  test('an unverifiable count throws — the caller decides', () => {
    const plane = testPlane('alpha', { fail: true });
    withPlane(plane, () => {
      assert.throws(
        () =>
          admitSessionStart({
            plane,
            command: 'alpha-run',
            agents: { alpha: { maxSessions: 1 } },
            key: 'call-1',
          }),
        (err: unknown) => err instanceof SpawnError && err.kind === 'unavailable'
      );
    });
  });

  test('a live mutex holder outlasting the wait throws LockTimeout — the caller owns the fallback', () => {
    withSlots(dir => {
      const plane = testPlane('alpha', { live: 0 });
      withPlane(plane, () => {
        // a live holder (this pid) parks on the kind's admission mutex
        const mutex = join(dir, 'admission.mutex');
        writeFileSync(mutex, String(process.pid), { flag: 'wx' });
        try {
          assert.throws(
            () =>
              admitSessionStart({
                plane,
                command: 'alpha-run',
                agents: { alpha: { maxSessions: 1, reservationsDir: dir } },
                key: 'call-1',
                waitMs: 150,
              }),
            (err: unknown) => err instanceof LockTimeout
          );
        } finally {
          rmSync(mutex, { force: true });
        }
      });
    });
  });

  test('the cap waits on the same mutex a spawn admission takes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-cap-mutex-'));
    try {
      const plane = testPlane('alpha', { live: 0 });
      // a child takes the kind's admission mutex by the REAL lock —
      // `admitSessionSlot` acquires `sessionAdmissionLock(kind, dir)`,
      // so the child asks the same function for the path rather than
      // hard-coding a file name: move the mutex and this test still
      // proves both serialize on it. The hold is ~600ms — the cap's
      // admit must wait, then succeed.
      const ready = join(dir, 'child.ready');
      const mutex = sessionAdmissionLock('alpha', dir);
      const childScript = join(dir, 'holder.ts');
      writeFileSync(
        childScript,
        `import { writeFileSync } from 'node:fs'\n` +
          `import { acquireFileLock } from ${JSON.stringify(join(here, 'filelock.ts'))}\n` +
          `import { sessionAdmissionLock } from ${JSON.stringify(join(here, 'session-planes.ts'))}\n` +
          `const release = acquireFileLock(sessionAdmissionLock('alpha', ${JSON.stringify(dir)}))\n` +
          `writeFileSync(${JSON.stringify(ready)}, String(process.pid))\n` +
          `setTimeout(() => { release(); process.exit(0) }, 600)\n`
      );
      const child = spawn(process.execPath, [childScript], { stdio: 'ignore' });
      await new Promise<void>(res => {
        const t0 = Date.now();
        const tick = (): void => {
          if ((existsSync(ready) && existsSync(mutex)) || Date.now() - t0 > 10_000) {
            res();
          } else {
            setTimeout(tick, 20);
          }
        };
        tick();
      });
      assert.ok(existsSync(ready), 'the child never took the admission mutex');
      assert.ok(existsSync(mutex), 'the admission mutex was never held');
      const started = Date.now();
      clearSessionPlanes();
      try {
        registerSessionPlane(plane);
        const admitted = admitSessionStart({
          plane,
          command: 'alpha-run',
          agents: { alpha: { maxSessions: 4, reservationsDir: dir } },
          key: 'call-1',
        });
        assert.equal(admitted?.refusal, undefined);
      } finally {
        clearSessionPlanes();
      }
      // admitted only after the child's hold ended — serialization
      // visible in wall time (same proof the spawn admission's test runs)
      assert.ok(
        Date.now() - started >= 400,
        `admit returned in ${Date.now() - started}ms — the mutex was not honored`
      );
      await new Promise<void>(res => child.on('exit', res));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('provider cap admission (spec bro-x601l)', () => {
  test('admitSessionStart judges the provider cap on the kind census', () => {
    withSlots(dir => {
      const plane = testPlane('alpha', { live: 2 });
      withPlane(plane, () => {
        const refused = admitSessionStart({
          plane,
          command: 'alpha-run',
          agents: {},
          key: 'call-1',
          providerCap: { provider: 'prov', cap: 2, reservationsDir: dir },
        });
        assert.ok(refused !== undefined);
        // post-claim census: 2 live + the held claim = 3 > 2
        assert.match(
          refused.refusal ?? '',
          /provider 'prov' lane cap reached — 3 live > 2.*fleet\.providerCaps\.prov.*provider_cap/
        );
        // a refused start holds no slot
        assert.equal(countSessionReservations(dir), 0);
      });
    });
  });

  test('providerCap alone arms the admission — no kind quota needed', () => {
    withSlots(dir => {
      const plane = testPlane('alpha', { live: 0 });
      withPlane(plane, () => {
        const admitted = admitSessionStart({
          plane,
          command: 'alpha-run',
          agents: {},
          key: 'call-1',
          providerCap: { provider: 'prov', cap: 1, reservationsDir: dir },
        });
        assert.equal(admitted?.refusal, undefined);
        // the claim landed in the KIND's dir — the census every other
        // provider-cap admission on this kind reads
        assert.equal(countSessionReservations(dir), 1);
        // the held claim fills the provider cap — the next start refuses
        const refused = admitSessionStart({
          plane,
          command: 'alpha-run',
          agents: {},
          key: 'call-2',
          providerCap: { provider: 'prov', cap: 1, reservationsDir: dir },
        });
        assert.match(refused?.refusal ?? '', /provider_cap/);
      });
    });
  });

  test('an unregistered plane still joins the provider census — the public API enforces the cap', () => {
    withSlots(dir => {
      clearSessionPlanes();
      try {
        // `admitSessionStart` takes its plane directly — the registry
        // never heard of it, so `planesStartingSessions` returns
        // nothing and a registry-only census would see zero. The
        // admit's own plane must join the census or its live sessions
        // and claims escape the cap entirely (spec bro-x601l).
        const plane = testPlane('alpha', { live: 1 });
        const refused = admitSessionStart({
          plane,
          command: 'alpha-run',
          agents: { alpha: { reservationsDir: dir } },
          key: 'call-1',
          providerCap: { provider: 'prov', cap: 1, reservationsDir: dir },
        });
        // the census sees the plane's 1 live + the held claim = 2 > 1
        assert.match(refused?.refusal ?? '', /provider_cap/);
        assert.equal(countSessionReservations(dir), 0);
      } finally {
        clearSessionPlanes();
      }
    });
  });

  test('a registered plane is counted once — the census dedups by kind', () => {
    withSlots(dir => {
      const plane = testPlane('alpha', { live: 1 });
      withPlane(plane, () => {
        // live 1 + the held claim = 2 = cap — admitted. A census that
        // counted the plane twice (registered AND appended) would read
        // 3 > 2 and refuse a rightful start.
        const admitted = admitSessionStart({
          plane,
          command: 'alpha-run',
          agents: { alpha: { reservationsDir: dir } },
          key: 'call-1',
          providerCap: { provider: 'prov', cap: 2, reservationsDir: dir },
        });
        assert.equal(admitted?.refusal, undefined);
        assert.equal(countSessionReservations(dir), 1);
      });
    });
  });

  test('the provider verdict rides the same admit as the kind quota — one claim', () => {
    withSlots(dir => {
      const plane = testPlane('alpha', { live: 0 });
      withPlane(plane, () => {
        const admitted = admitSessionStart({
          plane,
          command: 'alpha-run',
          agents: { alpha: { maxSessions: 9, reservationsDir: dir } },
          key: 'call-1',
          providerCap: { provider: 'prov', cap: 4, reservationsDir: dir },
        });
        assert.equal(admitted?.refusal, undefined);
        // ONE claim covers both caps — not one per cap
        assert.equal(countSessionReservations(dir), 1);
        assert.equal(admitted?.paths.length, 1);
      });
    });
  });

  test('the provider cap judges the combined census of every plane the command claims', () => {
    const dirA = mkdtempSync(join(tmpdir(), 'bro-cap-a-'));
    const dirB = mkdtempSync(join(tmpdir(), 'bro-cap-b-'));
    try {
      // a compound command one 'alpha' AND one 'beta' plane claim —
      // a per-plane census admits each in isolation and overshoots
      // the lane; the aggregate sees the earlier plane's claim
      const lane = { provider: 'prov', cap: 1 };
      const bags = { alpha: { reservationsDir: dirA }, beta: { reservationsDir: dirB } };
      clearSessionPlanes();
      try {
        registerSessionPlane(testPlane('alpha', { live: 0 }));
        registerSessionPlane(testPlane('beta', { live: 0 }));
        const first = admitSessionStart({
          plane: testPlane('alpha', { live: 0 }),
          command: 'alpha-run beta-run',
          agents: bags,
          key: 'call-1',
          providerCap: lane,
        });
        assert.equal(first?.refusal, undefined);
        assert.equal(countSessionReservations(dirA), 1);
        // the second plane's admission counts the alpha claim — 2 > 1
        const second = admitSessionStart({
          plane: testPlane('beta', { live: 0 }),
          command: 'alpha-run beta-run',
          agents: bags,
          key: 'call-1',
          providerCap: lane,
        });
        assert.match(
          second?.refusal ?? '',
          /provider 'prov' lane cap reached — 2 live > 1.*provider_cap/
        );
        // the refused claim went back — only the admitted one remains
        assert.equal(countSessionReservations(dirA), 1);
        assert.equal(countSessionReservations(dirB), 0);
      } finally {
        clearSessionPlanes();
      }
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  test('the locked census is post-claim — a rival claim between reads is judged', () => {
    withSlots(dir => {
      // the interleave the un-locked fallback could take: the rival's
      // claim lands after the section's own claim but before its
      // census — a count saved from before the claim would judge
      // stale headroom and both callers would proceed
      let counts = 0;
      const plane: SessionPlane = {
        kind: 'alpha',
        detectsCli: cli => cli === 'alpha-cli',
        startsSessions: command => (command.includes('alpha-run') ? 1 : 0),
        countLive: () => {
          counts++;
          if (counts === 2) {
            // the post-claim recount — the rival's claim is inside
            reserveSessionStart({ kind: 'alpha', agents: {}, key: 'rival', count: 1, dir });
          }
          return 0;
        },
      };
      withPlane(plane, () => {
        const refused = admitSessionStart({
          plane,
          command: 'alpha-run',
          agents: { alpha: { maxSessions: 1, reservationsDir: dir } },
          key: 'call-1',
        });
        // this call's claim plus the rival's = 2 > 1 — refused and
        // its own claim handed back
        assert.match(refused?.refusal ?? '', /alpha session quota reached — 2 live > 1/);
        assert.equal(countSessionReservations(dir), 1);
      });
    });
  });

  test('admitProviderSlot counts post-claim — a rival lane inside the census refuses it', () => {
    withSlots(dir => {
      const lane = { provider: 'prov', cap: 1, reservationsDir: dir };
      // countLanes runs INSIDE the mutex after the claim — the rival
      // lane it reports lands on top of this call's held slot
      const refused = admitProviderSlot(
        lane,
        () => {
          reserveSessionStart({
            kind: providerSlotsKind('prov'),
            agents: undefined,
            key: 'rival',
            count: 1,
            dir,
          });
          return 0;
        },
        { key: 'spawn-1' }
      );
      assert.match(
        refused?.refusal ?? '',
        /provider 'prov' lane cap reached — 2 live > 1.*provider_cap/
      );
      // the refused claim went back — the rival's remains
      assert.equal(countSessionReservations(dir), 1);
    });
  });

  test('admitProviderSlot — the caller census runs inside the provider mutex', () => {
    withSlots(dir => {
      const refused = admitProviderSlot(
        { provider: 'prov', cap: 2, reservationsDir: dir },
        () => 2,
        { key: 'spawn-1' }
      );
      assert.ok(refused !== undefined);
      // post-claim census: the caller's 2 lanes + the held claim = 3 > 2
      assert.match(
        refused.refusal ?? '',
        /provider 'prov' lane cap reached — 3 live > 2.*provider_cap/
      );
      assert.equal(refused.paths.length, 0);
      assert.equal(countSessionReservations(dir), 0);
    });
  });

  test('admitProviderSlot claims serialize — the next admit sees the slot', () => {
    withSlots(dir => {
      const lane = { provider: 'prov', cap: 1, reservationsDir: dir };
      const first = admitProviderSlot(lane, () => 0, { key: 'a' });
      assert.equal(first?.refusal, undefined);
      assert.equal(countSessionReservations(dir), 1);
      const second = admitProviderSlot(lane, () => 0, { key: 'b' });
      assert.match(second?.refusal ?? '', /provider_cap/);
    });
  });

  test('admitProviderSlot — the lane name survives provider keys with odd characters', () => {
    withSlots(dir => {
      // a provider key carrying path-unsafe chars lands sanitized, never
      // escaping the slots dir
      const adm = admitProviderSlot(
        { provider: 'weird/prov:name', cap: 1, reservationsDir: dir },
        () => 0,
        { key: 'a' }
      );
      assert.equal(adm?.refusal, undefined);
      assert.equal(countSessionReservations(dir), 1);
      for (const p of adm?.paths ?? []) {
        assert.ok(p.startsWith(dir), `claim escaped the slots dir: ${p}`);
      }
    });
  });

  test('providerSlotsKind encodes injectively — distinct keys never share a ledger', () => {
    const keys = ['a/b', 'a:b', 'a.b', 'a-b', 'a--b', 'ax002fb', 'weird/prov:name'];
    const kinds = keys.map(providerSlotsKind);
    // a flat unsafe-char→'-' fold would collapse 'a/b', 'a:b' and 'a.b'
    // onto one claim dir + mutex — the escaped fold keeps every key on
    // its own ledger so their caps never interfere
    assert.equal(new Set(kinds).size, keys.length);
    for (const kind of kinds) {
      assert.match(kind, /^provider-[A-Za-z0-9_-]+$/);
    }
    // the marker itself round-trips: '-' doubles, so an escaped key
    // never collides with a literal carrying the escape's shape
    assert.equal(providerSlotsKind('a-x002fb'), 'provider-a--x002fb');
  });

  test('a quota-free bag reservationsDir steers BOTH the mutex and the claims', () => {
    withSlots(dir => {
      const plane = testPlane('alpha', { live: 0 });
      withPlane(plane, () => {
        // no maxSessions — the provider cap alone arms the admission;
        // the bag's dir override must steer the same census the section
        // claims+counts in, or spawn and session-start admissions lock
        // different files over one ledger. A live file-form mutex in
        // THAT dir must stall this admit; a mutex on the default dir
        // would not contend at all.
        const mutex = sessionAdmissionLock('alpha', dir);
        writeFileSync(mutex, `${process.pid}:held`, { flag: 'wx' });
        try {
          assert.throws(
            () =>
              admitSessionStart({
                plane,
                command: 'alpha-run',
                agents: { alpha: { reservationsDir: dir } },
                key: 'call-1',
                providerCap: { provider: 'prov', cap: 4 },
                waitMs: 150,
              }),
            (err: unknown) => err instanceof LockTimeout
          );
        } finally {
          rmSync(mutex, { force: true });
        }
        const admitted = admitSessionStart({
          plane,
          command: 'alpha-run',
          agents: { alpha: { reservationsDir: dir } },
          key: 'call-1',
          providerCap: { provider: 'prov', cap: 4 },
        });
        assert.equal(admitted?.refusal, undefined);
        assert.equal(countSessionReservations(dir), 1);
      });
    });
  });

  test('the held refusals judge a census whose claims are already inside', () => {
    // post-claim: the pending starts are counted in `live` — the test
    // is strict, nothing remains "starting"
    assert.equal(sessionCapHeldRefusal({ kind: 'alpha', live: 3, cap: 3 }), undefined);
    assert.match(
      sessionCapHeldRefusal({ kind: 'alpha', live: 4, cap: 3 }) ?? '',
      /alpha session quota reached — 4 live > 3/
    );
    // cap <= 0 means uncapped, like the starts variant
    assert.equal(sessionCapHeldRefusal({ kind: 'alpha', live: 9, cap: 0 }), undefined);
    const lane = { provider: 'prov', cap: 2 };
    assert.equal(providerCapHeldRefusal(lane, 2), undefined);
    assert.match(
      providerCapHeldRefusal(lane, 3) ?? '',
      /provider 'prov' lane cap reached — 3 live > 2.*cause: provider_cap$/
    );
    // and the pre-claim twin still words the pending starts — both
    // halves of one contract
    assert.match(providerCapRefusal(lane, 2, 1) ?? '', /2 live \+ 1 starting > 2/);
  });

  test('two planes on a shared census dir never collapse one claim onto another (spec bro-x601l)', () => {
    withSlots(dir => {
      // a caller-scoped reservationsDir override puts BOTH kinds on one
      // ledger — the claim name must carry the kind or alpha's claim
      // reads as beta's own (a repeat event), and one slot stands in
      // for two sessions
      const a = reserveSessionStart({ kind: 'alpha', agents: {}, key: 'same-key', count: 1, dir });
      const b = reserveSessionStart({ kind: 'beta', agents: {}, key: 'same-key', count: 1, dir });
      assert.equal(a.fresh, true);
      assert.equal(b.fresh, true); // a second kind's claim is fresh — never adopted
      assert.equal(countSessionReservations(dir), 2);
    });
  });
});
