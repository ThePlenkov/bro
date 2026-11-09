import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { defineCommand, definePlugin, membersOf, type CommandPlugin } from './index.ts';
import { isPlugin, pluginGroups, registerExternal } from './registry.ts';

const FIXTURE = fileURLToPath(new URL('./fixtures/cli.ts', import.meta.url));

/** Run the fixture CLI — a real process, so the exit codes are the
 *  real ones. */
function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [FIXTURE, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

describe('the command bootstrap', () => {
  test('a flat plugin runs', async () => {
    const r = await run(['flat']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /flat/);
  });

  test('a nested command reaches its member', async () => {
    const r = await run(['db', 'migrate']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /migrate/);
  });

  test('the host case — the member wins over the host', async () => {
    const r = await run(['plan', 'run']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /plan-run/);
  });

  test('the host itself runs when no member is named', async () => {
    const r = await run(['plan']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /plan-host/);
  });

  test('a bare command prints its member table', async () => {
    const r = await run(['group']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Members:/);
    assert.match(r.stdout, /member/);
  });

  test('an unknown member is a usage error', async () => {
    const r = await run(['group', 'nope']);
    assert.equal(r.code, 2);
  });

  test('an unknown command is a usage error naming it', async () => {
    const r = await run(['nope']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /unknown command: nope/);
  });

  test('the bare CLI is a failure, not a usage error', async () => {
    const r = await run([]);
    assert.equal(r.code, 1);
  });

  test('a member that joins after the tree was built is still reachable', async () => {
    // the host loads external members in its prepare hook — a snapshot
    // taken at build time would hide them from their own group
    const r = await run(['late', 'joined']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /joined/);
  });

  test('a late member shows up in the group table', async () => {
    const r = await run(['late']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /joined/);
  });

  test('--help prints the usage text and succeeds', async () => {
    const r = await run(['--help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Usage: fixture/);
    assert.match(r.stdout, /Top-level:/);
  });

  test('help <cmd> is <cmd> --help', async () => {
    const r = await run(['help', 'db']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /db/);
  });

  test('help <plugin> never RUNS the plugin — the help token leads its argv', async () => {
    const r = await run(['help', 'runner', 'extra']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /runner-help/);
    assert.doesNotMatch(r.stdout, /runner-ran/);
  });

  test('a help token anywhere leads the plugin argv — the command never runs', async () => {
    const r = await run(['runner', 'extra', '--help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /runner-help/);
    assert.doesNotMatch(r.stdout, /runner-ran/);
  });

  test('the plugin still runs when no help token is in the argv', async () => {
    const r = await run(['runner', 'extra']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /runner-ran/);
  });

  test('help <group> <member> never RUNS the member', async () => {
    const r = await run(['help', 'shop', 'act', 'extra']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /act-help/);
    assert.doesNotMatch(r.stdout, /act-ran/);
  });

  test('the prefix keeps its place — the help token does not lose the selector', async () => {
    const r = await run(['help', 'creator', 'extra']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /create-help/);
    assert.doesNotMatch(r.stdout, /create-ran/);
  });

  test('--version prints the version', async () => {
    const r = await run(['--version']);
    assert.equal(r.code, 0);
    assert.match(r.stdout.trim(), /9\.9\.9/);
  });
});

describe('the registry', () => {
  test('the groups are derived from the plugin list', () => {
    const plugins: CommandPlugin[] = [
      definePlugin({ name: 'a', summary: 'a', group: 'g', run: () => undefined }),
      definePlugin({ name: 'b', summary: 'b', run: () => undefined }),
    ];
    const groups = pluginGroups(plugins);
    assert.deepEqual(groups.get('g')?.map((p) => p.name), ['a']);
  });

  test('an external plugin joins the registry', () => {
    const plugins: CommandPlugin[] = [];
    const { plugin, refusal } = registerExternal(
      plugins,
      { name: 'ext', summary: 'external', run: () => undefined },
      'some-spec'
    );
    assert.equal(refusal, undefined);
    assert.equal(plugin?.name, 'ext');
    assert.equal(plugins.length, 1);
  });

  test('a reserved name is refused, loudly', () => {
    const plugins: CommandPlugin[] = [];
    const { refusal } = registerExternal(
      plugins,
      { name: 'list', summary: 'external', run: () => undefined },
      'some-spec',
      new Set(['list'])
    );
    assert.equal(refusal?.reason, 'reserved');
    assert.equal(plugins.length, 0);
  });

  test('a taken name is refused', () => {
    const plugins: CommandPlugin[] = [
      definePlugin({ name: 'taken', summary: 'builtin', run: () => undefined }),
    ];
    const { refusal } = registerExternal(
      plugins,
      { name: 'taken', summary: 'external', run: () => undefined },
      'some-spec'
    );
    assert.equal(refusal?.reason, 'taken');
  });

  test('a non-plugin is refused', () => {
    const plugins: CommandPlugin[] = [];
    assert.equal(registerExternal(plugins, { name: 'x' }, 'spec').refusal?.reason, 'not-a-plugin');
    assert.equal(isPlugin({ name: 'x' }), false);
  });

  test('the members of a command are its plugins and its nested plugins, once each', () => {
    const shared = definePlugin({ name: 'shared', summary: 'shared', run: () => undefined });
    const cmd = defineCommand({
      name: 'root',
      plugins: [shared],
      commands: [
        defineCommand({
          name: 'nested',
          plugins: [shared, definePlugin({ name: 'own', summary: 'own', run: () => undefined })],
        }),
      ],
    });
    assert.deepEqual(membersOf(cmd).map((p) => p.name), ['shared', 'own']);
  });
});
