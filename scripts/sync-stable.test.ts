/** sync-stable — the canary branch's gate (see CONTRIBUTING.md "The
 *  stable branch"). The script mutates git refs, so what is unit-tested
 *  here is the part that decides HOW it mutates: the option parsing and
 *  the refusal rules. The git plumbing itself is exercised by running
 *  the script against this repo. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArgs } from './sync-stable.ts';

test('the script is inert without --sync — only --sync mutates anything', () => {
  const opts = parseArgs([]);
  assert.equal(opts.sync, false);
  assert.equal(opts.dryRun, false);
  assert.equal(opts.push, false);
});

test('--sync alone is the mutating mode', () => {
  const opts = parseArgs(['--sync']);
  assert.equal(opts.sync, true);
  assert.equal(opts.dryRun, false);
  assert.equal(opts.push, false);
  assert.equal(opts.skipE2e, false);
});

test('--dry-run plans without mutating', () => {
  const opts = parseArgs(['--sync', '--dry-run']);
  assert.equal(opts.sync, true);
  assert.equal(opts.dryRun, true);
});

test('--push is opt-in and never forced', () => {
  const opts = parseArgs(['--sync', '--push']);
  assert.equal(opts.push, true);
});

test('--skip-e2e is the flaky-target escape hatch', () => {
  assert.equal(parseArgs(['--sync', '--skip-e2e']).skipE2e, true);
});

test('--help wins over everything else', () => {
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
});

test('an unknown option is refused', () => {
  // the script exits with the usage error — the parse never returns
  assert.throws(() => parseArgs(['--nope']));
});
