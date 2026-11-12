/** The provider wall's cooldown (spec bro-i6811) — the accounting that
 *  stops a retry storm from spending one session per client request
 *  while the account is already saying no. */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AcpCooldownError, AcpLaneCooldown, acpWallOf } from './acp-cooldown.ts';

describe('acp lane cooldown (bro-i6811)', () => {
  test('a healthy lane refuses nothing', () => {
    const cooldown = new AcpLaneCooldown({ cooldownMs: 60_000 });
    assert.equal(cooldown.refusal(), undefined);
    assert.equal(cooldown.wallCount(), 0);
  });

  test('a wall closes the lane — the refusal names the wall', () => {
    const cooldown = new AcpLaneCooldown({ cooldownMs: 60_000 });
    cooldown.noteWall('the provider rate limited the request');
    const refusal = cooldown.refusal();
    assert.ok(refusal !== undefined);
    assert.equal(refusal.reason, 'the provider rate limited the request');
    assert.equal(refusal.retryAfterSec, 60);
  });

  test('the refusal carries the seconds the client must wait', () => {
    const cooldown = new AcpLaneCooldown({ cooldownMs: 30_000 });
    cooldown.noteWall('wall', { now: 1_000 });
    const refusal = cooldown.refusal(4_000);
    assert.equal(refusal?.retryAfterSec, 27);
  });

  test('the cooldown ends — the lane serves again', () => {
    const cooldown = new AcpLaneCooldown({ cooldownMs: 60_000 });
    cooldown.noteWall('wall', { now: 1_000 });
    assert.ok(cooldown.refusal(30_000) !== undefined);
    assert.equal(cooldown.refusal(61_001), undefined);
  });

  test('a disabled cooldown never refuses — the knob is honest', () => {
    const cooldown = new AcpLaneCooldown({ cooldownMs: 0 });
    cooldown.noteWall('wall');
    assert.equal(cooldown.refusal(), undefined);
    assert.equal(cooldown.wallCount(), 0);
  });

  test('a counted-but-unarmed wall does not close the lane', () => {
    const cooldown = new AcpLaneCooldown({ cooldownMs: 60_000 });
    cooldown.noteWall('wall', { arm: false });
    assert.equal(cooldown.refusal(), undefined);
    // but it IS counted — the second one is what closes the lane
    assert.equal(cooldown.wallCount(), 1);
  });

  test('a counted wall does not make the next wait longer', () => {
    const cooldown = new AcpLaneCooldown({ cooldownMs: 1_000 });
    cooldown.noteWall('wall', { now: 0, arm: false });
    cooldown.noteWall('wall', { now: 1_000 });
    // the escalation counts the ARMINGS — one arm, so the base window
    assert.equal(cooldown.refusal(1_000)?.retryAfterSec, 1);
  });

  test('repeated walls escalate — a lane the account cannot serve backs off', () => {
    const cooldown = new AcpLaneCooldown({ cooldownMs: 1_000, maxCooldownMs: 4_000 });
    // each wall arrives AFTER the previous cooldown ended — a wall
    // during an active cooldown is the same wall, not a new one
    cooldown.noteWall('wall', { now: 0 });
    assert.equal(cooldown.refusal(0)?.retryAfterSec, 1);
    cooldown.noteWall('wall', { now: 1_000 });
    assert.equal(cooldown.refusal(1_000)?.retryAfterSec, 2);
    cooldown.noteWall('wall', { now: 3_000 });
    assert.equal(cooldown.refusal(3_000)?.retryAfterSec, 4);
    // the escalation stops at the ceiling
    cooldown.noteWall('wall', { now: 7_000 });
    assert.equal(cooldown.refusal(7_000)?.retryAfterSec, 4);
  });

  test('a wall during an active cooldown does not escalate it', () => {
    // several turns were in flight when the account said no, and each
    // of them fails with the same refusal — one wall, not five
    const cooldown = new AcpLaneCooldown({ cooldownMs: 1_000, maxCooldownMs: 60_000 });
    cooldown.noteWall('wall', { now: 0 });
    for (let i = 1; i <= 5; i++) {
      cooldown.noteWall('wall', { now: i * 10 });
    }
    // the wait is still the base window — the wall did not escalate
    assert.equal(cooldown.refusal(0)?.retryAfterSec, 1);
    assert.equal(cooldown.refusal(500)?.retryAfterSec, 1);
  });

  test('a wall during an active cooldown never shortens it', () => {
    const cooldown = new AcpLaneCooldown({ cooldownMs: 60_000 });
    cooldown.noteWall('wall', { now: 0, retryAfterSec: 600 });
    assert.equal(cooldown.refusal(0)?.retryAfterSec, 600);
    // a later wall with a shorter wait must not pull the deadline in
    cooldown.noteWall('wall', { now: 1_000, retryAfterSec: 5 });
    assert.equal(cooldown.refusal(1_000)?.retryAfterSec, 599);
  });

  test("the provider's own retry-after is a floor under the wait", () => {
    const cooldown = new AcpLaneCooldown({ cooldownMs: 1_000 });
    cooldown.noteWall('wall', { now: 0, retryAfterSec: 120 });
    assert.equal(cooldown.refusal(0)?.retryAfterSec, 120);
  });

  test('the escalation resets after a quiet window — a recovered account is served', () => {
    const cooldown = new AcpLaneCooldown({ cooldownMs: 1_000, windowMs: 10_000 });
    cooldown.noteWall('wall', { now: 0 });
    cooldown.noteWall('wall', { now: 1_000 });
    assert.equal(cooldown.refusal(1_000)?.retryAfterSec, 2);
    // the window rolled — the tally starts clean
    assert.equal(cooldown.wallCount(20_000), 0);
    cooldown.noteWall('wall', { now: 20_000 });
    assert.equal(cooldown.refusal(20_000)?.retryAfterSec, 1);
  });

  test('the refusal is an error the wire can carry', () => {
    const cooldown = new AcpLaneCooldown({ cooldownMs: 60_000 });
    cooldown.noteWall('the provider rate limited the request');
    const refusal = cooldown.refusal();
    assert.ok(refusal !== undefined);
    const err = new AcpCooldownError(refusal);
    assert.ok(err instanceof AcpCooldownError);
    assert.equal(err.retryAfterSec, refusal.retryAfterSec);
    assert.match(err.message, /no session was opened/);
  });
});

describe('the wall classifier (bro-i6811)', () => {
  test('a quota wall is a wall — and it is immediate', () => {
    const wall = acpWallOf(
      new Error('acp conductor:devin-acp unavailable — Reached free model rate limit')
    );
    assert.ok(wall !== undefined);
    assert.match(wall.reason, /rate limited/);
    // the account said so in so many words — the lane closes at once
    assert.equal(wall.immediate, true);
  });

  test('a capacity wall is a wall — but it is not immediate', () => {
    const wall = acpWallOf(new Error('acp conductor:dv-acp unavailable — Internal error'));
    assert.ok(wall !== undefined);
    assert.match(wall.reason, /could not serve/);
    // one failed turn is an incident of THIS turn — the second one in
    // the window is what says the account is struggling
    assert.equal(wall.immediate, false);
  });

  test("bro's own wrapper word is not a signal — it wraps every failure", () => {
    // "acp <entry> unavailable" is bro's own wording for ANY failure —
    // matching it would close the lane on an auth error too
    assert.equal(
      acpWallOf(new Error('acp dv-acp unavailable — Authentication required')),
      undefined
    );
    assert.equal(
      acpWallOf(new Error('acp dv-acp unavailable — upstream connection reset')),
      undefined
    );
  });

  test('the refusal is never a wall — the wait never extends itself', () => {
    const err = new AcpCooldownError({
      reason: 'the provider rate limited the request',
      retryAfterSec: 60,
    });
    assert.equal(acpWallOf(err), undefined);
    // even wrapped in bro's own wording
    assert.equal(
      acpWallOf(new Error(`acp dv-acp unavailable — ${err.message}`, { cause: err })),
      undefined
    );
  });

  test('an HTTP status is a wall', () => {
    const err = Object.assign(new Error('nope'), { status: 429 });
    assert.ok(acpWallOf(err) !== undefined);
    const cap = acpWallOf(Object.assign(new Error('nope'), { status: 529 }));
    assert.ok(cap !== undefined);
    // a 529 is a CAPACITY wall — the message class is non-immediate too,
    // so the two spellings agree
    assert.equal(cap.immediate, false);
  });

  test("the provider's own retry-after is read when the failure carries one", () => {
    const err = Object.assign(new Error('rate limit exceeded'), { retryAfter: 90 });
    assert.equal(acpWallOf(err)?.retryAfterSec, 90);
    const header = Object.assign(new Error('rate limit exceeded'), {
      headers: { 'retry-after': '45' },
    });
    assert.equal(acpWallOf(header)?.retryAfterSec, 45);
  });

  test('the status outranks the message — a local cap carrying a 429 is a wall', () => {
    const err = Object.assign(new Error('session quota reached — 1 live + 1 starting > 1'), {
      status: 429,
    });
    assert.ok(acpWallOf(err) !== undefined);
  });

  test("bro's own session cap is NOT the account's wall", () => {
    // the local cap resolves on its own — arming the cooldown on it
    // would refuse a lane that is serving fine
    const wall = acpWallOf(
      new Error('devin session quota reached — 1 live + 1 starting > 1 (agents.devin.maxSessions)')
    );
    assert.equal(wall, undefined);
  });

  test('a timeout is not a wall — the account did not say no', () => {
    assert.equal(acpWallOf(new Error('the turn timed out')), undefined);
    assert.equal(
      acpWallOf(new Error("model 'devin/swe-2-max' is not in the agent's catalog")),
      undefined
    );
    assert.equal(acpWallOf(new Error('agent requires interactive auth')), undefined);
  });

  test('a non-error is not a wall', () => {
    assert.equal(acpWallOf(undefined), undefined);
    assert.equal(acpWallOf(''), undefined);
  });
});
