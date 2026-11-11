/** The omp adapter's force-push guard — the one rule the hook exists
 *  for. A force push rewrites shared history, and bro's occupancy plane
 *  is built on branches staying stable, so the guard must not be
 *  defeated by a bracket, a line continuation or a flag-looking word in
 *  another command. */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { isForcePush } from './omp-hook.ts';

describe('the omp force-push guard', () => {
  test('a plain force push is refused', () => {
    assert.equal(isForcePush('git push --force origin main'), true);
    assert.equal(isForcePush('git push -f origin main'), true);
    assert.equal(isForcePush('git push origin +main'), true);
  });

  test('the safe spellings pass', () => {
    assert.equal(isForcePush('git push --force-with-lease origin main'), false);
    assert.equal(isForcePush('git push --force-if-includes origin main'), false);
    assert.equal(isForcePush('git push origin main'), false);
  });

  test('a grouped command is still a force push', () => {
    // the shell runs `(git push --force origin main)` exactly as it runs
    // the bare command — a bracket must not defeat the guard
    assert.equal(isForcePush('(git push --force origin main)'), true);
    assert.equal(isForcePush('{ git push --force origin main; }'), true);
  });

  test('a continued line is one command to the shell', () => {
    // the backslash and the newline vanish — `git \` + newline +
    // `push --force` is ONE command, and the guard must read it as one
    assert.equal(isForcePush('git \\\n  push --force origin main'), true);
    assert.equal(isForcePush('git push --force \\\n  origin main'), true);
  });

  test('a flag-looking word in another command never trips the guard', () => {
    assert.equal(isForcePush('echo --force'), false);
    assert.equal(isForcePush('npm run build --force'), false);
    assert.equal(isForcePush('grep --force file'), false);
  });

  test('git global options between git and push are read', () => {
    assert.equal(isForcePush('git -C /repo push --force origin main'), true);
    assert.equal(isForcePush('git -c core.hooksPath=/x push --force'), true);
  });
});
