/** The shell reader's launched-command view — `commandCliNames` sees
 *  the same command words the session planes count starts on, so a
 *  caller resolving "which cli does this template launch" can never
 *  drift from what the caps enforce. */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { commandCliNames, commandWorkerClis } from './shell.ts';

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

  test('shell options ahead of -c still reach the script', () => {
    assert.deepEqual(commandCliNames("bash -l -c 'devin -p a'"), ['devin']);
    assert.deepEqual(commandCliNames("bash -e -c 'devin -p a'"), ['devin']);
    // -o/-O take the NEXT token as the option's value — it is not the script
    assert.deepEqual(commandCliNames("bash -o errexit -c 'devin -p a'"), ['devin']);
    assert.deepEqual(commandCliNames("bash -lo errexit -c 'devin -p a'"), ['devin']);
    // the first operand is a FILE the shell runs — a -c behind it is
    // the script's own argument, not a command line
    assert.deepEqual(commandCliNames("bash setup.sh -c 'devin -p a'"), ['bash']);
  });

  test('an unquoted -c operand is still the command — its positionals are not', () => {
    assert.deepEqual(commandCliNames('bash -c devin'), ['devin']);
    assert.deepEqual(commandCliNames('sh -c devin'), ['devin']);
    // later positionals are the script's $0/args — never part of it
    assert.deepEqual(commandCliNames('bash -c devin argv0 --x'), ['devin']);
  });

  test('a # outside quotes comments the rest of the line out', () => {
    // the ; inside the comment splits nothing — claude never runs
    assert.deepEqual(commandCliNames('devin a # note; claude b'), ['devin']);
    // the comment ends at the newline — which itself separates
    assert.deepEqual(commandCliNames('devin a # note\nclaude b'), ['devin', 'claude']);
    // inside a word or a quote the # is text
    assert.deepEqual(commandCliNames('devin -p "#tag"'), ['devin']);
    assert.deepEqual(commandCliNames('x#y -p a'), ['x#y']);
  });
});

describe('commandWorkerClis', () => {
  test('the scaffolding around the worker drops out', () => {
    assert.deepEqual(commandWorkerClis('cd /tmp && devin -p a'), ['devin']);
    assert.deepEqual(commandWorkerClis('devin -p a; echo done'), ['devin']);
    assert.deepEqual(commandWorkerClis('git pull && devin -p a | tee log'), ['devin']);
    assert.deepEqual(commandWorkerClis('cd /tmp && env F=1 devin -p a; echo done'), ['devin']);
  });

  test('a command whose every cli is scaffolding keeps them all', () => {
    // an exotic worker named like a builtin still identifies itself —
    // dropping everything would make the worker unnamable
    assert.deepEqual(commandWorkerClis('cd /tmp && test -f x'), ['cd', 'test']);
    assert.deepEqual(commandWorkerClis(''), []);
  });
});
