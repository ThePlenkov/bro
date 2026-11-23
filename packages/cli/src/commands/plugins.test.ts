import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { runPluginsCommand } from './plugins.ts';

/** `bro plugins` is the BroPlugin registry — plugins FOR bro. The
 *  client × scope install matrix lives at `bro clients` (specs/bro-cl1). */
describe('plugins — the registry surface', () => {
  const plugins = [
    { name: 'act', group: 'review', summary: 'the gate', run: () => {}, skill: 'act' },
    { name: 'hooks', summary: 'plumbing', run: () => {}, hidden: true },
    {
      name: 'wtf',
      group: 'self',
      summary: 'vent',
      run: () => {},
      aliasOf: 'retrospect capture',
    },
  ];

  function captured(argv: string[]): { out: string; err: string } {
    const orig = { log: console.log, error: console.error };
    let out = '';
    let err = '';
    console.log = (s: unknown) => {
      out += String(s);
    };
    console.error = (s: unknown) => {
      err += String(s);
    };
    try {
      runPluginsCommand(argv, plugins as never);
    } finally {
      console.log = orig.log;
      console.error = orig.error;
    }
    return { out, err };
  }

  test('prints the registry as data — the generator contract', () => {
    const { out } = captured(['--json']);
    const rows = JSON.parse(out) as {
      name: string;
      group?: string;
      hidden: boolean;
      aliasOf?: string;
      plan: boolean;
      external: boolean;
    }[];
    assert.equal(rows.length, 3);
    // JSON.stringify drops undefined keys — the row is sparse by design
    assert.deepEqual(rows[0], {
      name: 'act',
      group: 'review',
      summary: 'the gate',
      skill: 'act',
      hidden: false,
      plan: false,
      external: false,
    });
    assert.equal(rows[1]!.hidden, true);
    assert.equal(rows[2]!.aliasOf, 'retrospect capture');
  });

  test('list is a registry alias now — the matrix moved, and it says so', () => {
    const { out, err } = captured(['list']);
    assert.match(out, /act/);
    assert.match(err, /bro clients list/);
    const json = captured(['list', '--json']);
    assert.deepEqual(JSON.parse(json.out), JSON.parse(captured(['--json']).out));
  });

  test('install routes to bro clients with a stderr note', () => {
    const { err } = captured(['install', 'opencode', '--dry-run', '--global']);
    assert.match(err, /bro plugins install moved/);
  });

  test('an unknown subcommand is a usage error', () => {
    assert.throws(
      () => runPluginsCommand(['frobnicate'], plugins as never),
      (err: unknown) => (err as { code?: number }).code === 2
    );
  });
});
