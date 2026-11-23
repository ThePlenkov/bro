/** The shell reader's launched-command view — `commandCliNames` sees
 *  the same command words the session planes count starts on, so a
 *  caller resolving "which cli does this template launch" can never
 *  drift from what the caps enforce. */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { commandCliNames } from './shell.ts';

describe('commandCliNames', () => {
  test('the bare command is its own cli', () => {
    assert.deepEqual(commandCliNames('devin'), ['devin']);
    assert.deepEqual(commandCliNames('devin -p "do the thing"'), ['devin']);
    assert.deepEqual(commandCliNames('/usr/local/bin/devin acp'), ['devin']);
  });

  test('nothing launched is an empty list', () => {
    assert.deepEqual(commandCliNames(''), []);
    assert.deepEqual(commandCliNames('   '), []);
    assert.deepEqual(commandCliNames('FOO=bar'), []);
  });

  test('every segment contributes its command', () => {
    assert.deepEqual(commandCliNames('devin a & devin b'), ['devin', 'devin']);
    assert.deepEqual(commandCliNames('cd /tmp; devin -p a | tee log'), ['cd', 'devin', 'tee']);
  });

  test('assignments and wrappers are skipped, not launched', () => {
    assert.deepEqual(commandCliNames('FOO=bar devin -p a'), ['devin']);
    assert.deepEqual(commandCliNames('env -i devin -p a'), ['devin']);
    assert.deepEqual(commandCliNames('env V=1 nice -n 5 timeout 30 devin -p a'), ['devin']);
    assert.deepEqual(commandCliNames('nohup devin -p a'), ['devin']);
    assert.deepEqual(commandCliNames('sudo -u root devin -p a'), ['devin']);
    assert.deepEqual(commandCliNames('npx devin -p a'), ['devin']);
  });

  test('a shell -c script launches the commands it carries', () => {
    assert.deepEqual(commandCliNames("sh -c 'devin -p a'"), ['devin']);
    assert.deepEqual(commandCliNames('bash -c "devin -p a"'), ['devin']);
    assert.deepEqual(commandCliNames("bash -lc 'devin -p a'"), ['devin']);
    assert.deepEqual(commandCliNames("FOO=1 sh -c 'devin -p a' & devin -p b"), ['devin', 'devin']);
    // the script is a segment list of its own
    assert.deepEqual(commandCliNames("sh -c 'devin a & claude b'"), ['devin', 'claude']);
    // nested -c unwraps while the depth cap allows — a layer too deep
    // leaves the shell itself as the command word (the plane stops
    // reading there too, so no start is counted either)
    assert.deepEqual(commandCliNames(`sh -c "sh -c 'devin'"`), ['devin']);
    assert.deepEqual(commandCliNames(`sh -c "sh -c \\"sh -c 'devin'\\""`), ['sh']);
  });

  test('a cli named only as an argument is not a launch', () => {
    assert.deepEqual(commandCliNames('echo devin'), ['echo']);
    assert.deepEqual(commandCliNames("sh -c 'echo devin'"), ['echo']);
    assert.deepEqual(commandCliNames('grep devin .git/bro/agents.json'), ['grep']);
    assert.deepEqual(commandCliNames("bro acp-worker --command 'devin acp'"), ['bro']);
    assert.deepEqual(commandCliNames('command -v devin'), ['command']);
  });

  test('a separator inside a quoted argument does not split', () => {
    assert.deepEqual(commandCliNames('devin -p "run devin later; then stop"'), ['devin']);
  });
});
