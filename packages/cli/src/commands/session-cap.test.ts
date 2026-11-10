/** The session cap at the call sites the admission does not cover (spec
 *  bro-bww9v): the guard plane's veto and the ACP surface's refusal. */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SESSION_SLOT_TTL_MS,
  clearSessionPlanes,
  registerSessionPlane,
  sessionCapViews,
  type PreToolVerdict,
  type SessionPlane,
} from '@broject/core';
import {
  conductorSessionRefusal,
  pendingOpensBeyondClaim,
  sessionCapRefusalForHook,
  sessionCapVerdict,
} from './session-cap.ts';

/** A plane that claims a command by a marker word and counts a
 *  scripted number of live sessions. */
const testPlane = (
  kind: string,
  opts: { live?: number; starts?: number; fail?: boolean } = {}
): SessionPlane => ({
  kind,
  detectsCli: cli => cli === `${kind}-cli`,
  startsSessions: command => (command.includes(`${kind}-run`) ? (opts.starts ?? 1) : 0),
  countLive: () => {
    if (opts.fail === true) {
      throw new Error('cannot count');
    }
    return opts.live ?? 0;
  },
});

const ctx = { dir: process.cwd(), sessionId: 'sess-1' } as never;

/** The guard's verdict for a command, under a given config. */
const verdictFor = (
  command: string,
  bags: Record<string, Record<string, unknown>>
): PreToolVerdict[] => sessionCapVerdict(ctx, { tool: 'bash', input: { command } }, bags);

const withPlane = (plane: SessionPlane, fn: () => void): void => {
  clearSessionPlanes();
  try {
    registerSessionPlane(plane);
    fn();
  } finally {
    clearSessionPlanes();
  }
};

/** A scratch reservations dir — the claim files live here, never in the
 *  developer's real data home (a claim that outlives the test would
 *  count against the next run). */
const withReservations = (fn: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), 'bro-cap-resv-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe('sessionCapVerdict', () => {
  test('a start at the cap is vetoed', () => {
    withReservations(dir => {
      withPlane(testPlane('fake', { live: 3 }), () => {
        const verdicts = verdictFor('fake-run --now', {
          fake: { maxSessions: 3, reservationsDir: dir },
        });
        assert.equal(verdicts.length, 1);
        assert.match(verdicts[0]!.block ?? '', /fake session quota reached/);
      });
    });
  });

  test('a start below the cap is allowed', () => {
    withReservations(dir => {
      withPlane(testPlane('fake', { live: 1 }), () => {
        const verdicts = verdictFor('fake-run --now', {
          fake: { maxSessions: 3, reservationsDir: dir },
        });
        assert.deepEqual(verdicts, []);
      });
    });
  });

  test('a command no plane claims is never touched', () => {
    withPlane(testPlane('fake', { live: 99 }), () => {
      const verdicts = verdictFor('ls -la', { fake: { maxSessions: 3 } });
      assert.deepEqual(verdicts, []);
    });
  });

  test('a tool call without a command is never touched', () => {
    withPlane(testPlane('fake', { live: 99 }), () => {
      const verdicts = sessionCapVerdict(
        ctx,
        { tool: 'read', input: { file_path: '/x' } },
        { fake: { maxSessions: 3 } }
      );
      assert.deepEqual(verdicts, []);
    });
  });

  test('an unverifiable count fails OPEN — a hook never stalls the client', () => {
    withPlane(testPlane('fake', { fail: true }), () => {
      const verdicts = verdictFor('fake-run --now', { fake: { maxSessions: 3 } });
      assert.deepEqual(verdicts, []);
    });
  });

  test('an allowed start claims the slot — a burst shares one budget', () => {
    withReservations(dir => {
      withPlane(testPlane('burst', { live: 0 }), () => {
        const bags = { burst: { maxSessions: 1, reservationsDir: dir } };
        // the cap is 1: the first start is allowed and claims the slot
        const first = verdictFor('burst-run --now', bags);
        assert.deepEqual(first, []);
        // a second start (a different command, a different claim) sees
        // the first claim and is refused
        const second = verdictFor('burst-run --later', bags);
        assert.equal(second.length, 1);
        assert.match(second[0]!.block ?? '', /burst session quota reached/);
      });
    });
  });

  test('the same call asked twice claims ONE slot and is not refused', () => {
    withReservations(dir => {
      withPlane(testPlane('twice', { live: 0 }), () => {
        const bags = { twice: { maxSessions: 1, reservationsDir: dir } };
        // a call's identity is its toolUseId — the two hook events of
        // one call share it; without one each event is a DISTINCT call
        // and must claim its own slot
        const callCtx = { dir: process.cwd(), sessionId: 'sess-1', toolUseId: 'tw-1' } as never;
        const call = () =>
          sessionCapVerdict(callCtx, { tool: 'bash', input: { command: 'twice-run --now' } }, bags);
        // the pre-tool event claims the slot...
        assert.deepEqual(call(), []);
        // ...and the permission event for the SAME call must not count
        // its start twice (the claim is already in the live count)
        assert.deepEqual(call(), []);
      });
    });
  });

  test('a contended admission mutex degrades to the un-locked path — the hook never stalls', () => {
    withReservations(dir => {
      withPlane(testPlane('fake', { live: 3 }), () => {
        // a live holder (this pid) parks on the kind's admission mutex —
        // the verdict must still arrive, and the cap still applies
        writeFileSync(join(dir, 'admission.mutex'), String(process.pid), { flag: 'wx' });
        try {
          const verdicts = sessionCapVerdict(
            ctx,
            { tool: 'bash', input: { command: 'fake-run --now' } },
            { fake: { maxSessions: 3, reservationsDir: dir } },
            150
          );
          assert.equal(verdicts.length, 1);
          assert.match(verdicts[0]!.block ?? '', /fake session quota reached/);
        } finally {
          rmSync(join(dir, 'admission.mutex'), { force: true });
        }
      });
    });
  });

  test('a pre-update claim under the raw key is recognized — the call is not counted twice', () => {
    withReservations(dir => {
      withPlane(testPlane('upg', { live: 0 }), () => {
        const bags = { upg: { maxSessions: 1, reservationsDir: dir } };
        // the pre-sanitization key format claimed this call's slot —
        // `guard-<raw session>-id-<raw toolUseId>-0.slot`
        writeFileSync(join(dir, 'guard-sess-1-id-call-9-0.slot'), String(Date.now()));
        // the updated binary's event for the SAME call must see the
        // held slot, not take a second one and refuse itself at cap 1
        const verdicts = sessionCapVerdict(
          { dir: process.cwd(), sessionId: 'sess-1', toolUseId: 'call-9' } as never,
          { tool: 'bash', input: { command: 'upg-run --now' } },
          bags
        );
        assert.deepEqual(verdicts, []);
        // the claim migrated to the new key — one file, not two
        const files = readdirSync(dir).filter(n => n.endsWith('.slot'));
        assert.equal(files.length, 1);
        assert.ok(files[0]!.startsWith('guard-sess-1-'));
      });
    });
  });

  test('lone-surrogate tool-use ids do not share a claim', () => {
    withReservations(dir => {
      withPlane(testPlane('surr', { live: 0 }), () => {
        const bags = { surr: { maxSessions: 2, reservationsDir: dir } };
        const call = (id: string) =>
          sessionCapVerdict(
            { dir: process.cwd(), sessionId: 'sess-1', toolUseId: id } as never,
            { tool: 'bash', input: { command: 'surr-run --now' } },
            bags
          );
        assert.deepEqual(call('x/\ud800'), []);
        // utf8 folds every unpaired surrogate into U+FFFD — the second
        // id hashed IDENTICALLY, reused the first claim, and the cap
        // read two starts as one. utf16le keeps them distinct.
        assert.deepEqual(call('x/\ud801'), []);
        assert.equal(readdirSync(dir).filter(n => n.endsWith('.slot')).length, 2);
      });
    });
  });
});

describe('sessionCapRefusalForHook', () => {
  test('the devin client vetoes a session start at the cap', () => {
    withReservations(dir => {
      withPlane(testPlane('devin', { live: 3 }), () => {
        const refusal = sessionCapRefusalForHook('devin-run --now', process.cwd(), 'sess-1', {
          devin: { maxSessions: 3, reservationsDir: dir },
        });
        assert.ok(refusal !== undefined);
        assert.match(refusal, /devin session quota reached/);
      });
    });
  });

  test('a command that starts nothing is never refused', () => {
    withReservations(dir => {
      withPlane(testPlane('devin', { live: 3 }), () => {
        assert.equal(
          sessionCapRefusalForHook('ls -la', process.cwd(), 'sess-1', {
            devin: { maxSessions: 3, reservationsDir: dir },
          }),
          undefined
        );
      });
    });
  });
});

describe('conductorSessionRefusal', () => {
  test('the retained conversations count with the host', () => {
    const view = sessionCapViews('nope', { fake: { maxSessions: 3 } })[0];
    assert.equal(conductorSessionRefusal(undefined, 5), undefined);
    const v = { kind: 'fake', live: 1, cap: 3, starts: 1 };
    assert.equal(conductorSessionRefusal(v, 1, 0), undefined);
    assert.equal(conductorSessionRefusal(v, 0, 2), undefined);
    assert.ok(conductorSessionRefusal(v, 1, 2) !== undefined);
  });
});

describe('pendingOpensBeyondClaim', () => {
  test('an open still inside its claim stays in the reservation count', () => {
    const now = Date.now();
    const pending = new Map<string, number>([
      ['fresh', now - 1_000],
      ['expired', now - SESSION_SLOT_TTL_MS],
      ['older', now - SESSION_SLOT_TTL_MS * 2],
    ]);
    // only the opens whose claim outlived the shared TTL count —
    // 'fresh' is already inside view.live's reservation term
    assert.equal(pendingOpensBeyondClaim(pending, now), 2);
    assert.equal(pendingOpensBeyondClaim(new Map(), now), 0);
  });
});
