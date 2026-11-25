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
  });

  test('bundled short options still read as force (bro-u93xd)', () => {
    assert.equal(isForcePush('git push -vf origin main'), true);
    assert.equal(isForcePush('git push -fv origin main'), true);
    // -u/-n/-q bundles without f stay clean
    assert.equal(isForcePush('git push -vn origin main'), false);
    assert.equal(isForcePush('git push -u origin main'), false);
  });

  test('shell wrapping does not hide the push (bro-u93xd)', () => {
    assert.equal(isForcePush("sh -c 'git push --force origin main'"), true);
    assert.equal(isForcePush('sh -c "git push -f origin main"'), true);
    assert.equal(isForcePush('x=$(git push -f origin main)'), true);
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

  void test('push-options are not force flags (macroscope)', () => {
    assert.equal(isForcePush('git push -ofoo origin main'), false);
    assert.equal(isForcePush('git push -o ci.skip origin main'), false);
    // a bundle reaching -o never reads the value as flags — but an f
    // BEFORE it is still force
    assert.equal(isForcePush('git push -fv origin main'), true);
    assert.equal(isForcePush('git push -fo ci.skip origin main'), true);
  });

  void test('closing grouping furniture does not hide the flag', () => {
    assert.equal(isForcePush('(git push origin main --force)'), true);
    assert.equal(isForcePush('sh -c "git push --force"'), true);
  });

  void test('nested substitution inside another command is still a push', () => {
    assert.equal(isForcePush('git log "$(git push --force origin main)"'), true);
    assert.equal(isForcePush('echo $(git push -f)'), true);
  });

  void test('redirection does not glue onto the flag (macroscope)', () => {
    assert.equal(isForcePush('git push origin main --force>push.log'), true);
    assert.equal(isForcePush('git push -f 2>/dev/null'), true);
  });
});
