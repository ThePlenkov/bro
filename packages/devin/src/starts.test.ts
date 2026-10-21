/** The devin CLI's grammar — which commands open a session (spec
 *  bro-bww9v). The cap is judged against `live + starts`, so the plane
 *  must count the starts, not detect the binary. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { countDevinSessionStarts } from './starts.ts'

describe('countDevinSessionStarts', () => {
  test('the bare CLI opens an interactive session', () => {
    assert.equal(countDevinSessionStarts('devin'), 1)
    assert.equal(countDevinSessionStarts('devin .'), 1)
  })

  test('the one-shot and the cloud flags open a session', () => {
    assert.equal(countDevinSessionStarts('devin -p "do the thing"'), 1)
    assert.equal(countDevinSessionStarts('devin --print "do the thing"'), 1)
    assert.equal(countDevinSessionStarts('devin --cloud'), 1)
    assert.equal(countDevinSessionStarts('devin --prompt-file /tmp/p.md'), 1)
  })

  test('the acp server opens a session', () => {
    assert.equal(countDevinSessionStarts('devin acp'), 1)
    assert.equal(countDevinSessionStarts('devin acp --model swe-2-max'), 1)
  })

  test('the read-only verbs open none', () => {
    for (const cmd of [
      'devin models',
      'devin list',
      'devin ls',
      'devin doctor',
      'devin rm elated-bite --force',
      'devin auth login',
      'devin rules list',
      'devin skills list',
      'devin plugins list',
      'devin mcp list',
      'devin update',
      'devin version',
      'devin setup',
      'devin uninstall',
      'devin help',
      'devin desktop',
      'devin sandbox',
      'devin ssh box-1',
      'devin forward 8080:8080',
    ]) {
      assert.equal(countDevinSessionStarts(cmd), 0, cmd)
    }
  })

  test('the cloud verb opens a session, its resource verbs do not', () => {
    assert.equal(countDevinSessionStarts('devin cloud'), 1)
    assert.equal(countDevinSessionStarts('devin cloud list'), 0)
    assert.equal(countDevinSessionStarts('devin cloud ls'), 0)
  })

  test('devin as an ARGUMENT is not a session start', () => {
    assert.equal(countDevinSessionStarts('grep devin .git/bro/agents.json'), 0)
    assert.equal(countDevinSessionStarts('echo devin'), 0)
    assert.equal(countDevinSessionStarts('cat /usr/bin/devin'), 0)
  })

  test('a compound command counts every start', () => {
    assert.equal(countDevinSessionStarts('devin -p a & devin -p b'), 2)
    assert.equal(countDevinSessionStarts('cd /tmp && devin -p a'), 1)
    assert.equal(countDevinSessionStarts('devin models; devin -p a'), 1)
    assert.equal(countDevinSessionStarts('devin -p a | tee log'), 1)
  })

  test('a wrapped binary is still the binary', () => {
    assert.equal(countDevinSessionStarts('npx devin -p a'), 1)
    assert.equal(countDevinSessionStarts('/usr/local/bin/devin -p a'), 1)
  })

  test('a quoted command string is one argument, not a start', () => {
    assert.equal(countDevinSessionStarts("bro acp-worker --command 'devin acp --model x'"), 0)
  })

  test('nothing to start is zero', () => {
    assert.equal(countDevinSessionStarts(''), 0)
    assert.equal(countDevinSessionStarts('ls -la'), 0)
  })
})
