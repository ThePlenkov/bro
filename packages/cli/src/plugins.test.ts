import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { connectors } from '@broject/core';
import { tmpDir } from './commands/testrepo.ts';
import {
  assertMutableConfig,
  ConfigPolicyError,
  connectorProblem,
  loadExternalPlugins,
  PLUGINS,
  pluginConfigSections,
  pluginExportProblem,
  pluginGroups,
  runPlanFile,
} from './plugins.ts';

// the global config layer (~/.config/bro) must not leak the dev
// machine's real user config into the registry/diagnostics tests —
// pin it at an empty tmp for the whole file
const prevXdg = process.env.XDG_CONFIG_HOME;
process.env.XDG_CONFIG_HOME = tmpDir('bro-plugins-xdg-');
process.on('exit', () => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
});

function repoWith(pluginSource: string | null, plugins: unknown): string {
  const dir = tmpDir('bro-ext-');
  writeFileSync(join(dir, 'bro.config.json'), JSON.stringify({ plugins }));
  if (pluginSource !== null) {
    writeFileSync(join(dir, 'my.ts'), pluginSource);
  }
  return dir;
}

function unload(loaded: { name: string }[]): void {
  for (const p of loaded) {
    const i = PLUGINS.findIndex(x => x.name === p.name);
    if (i >= 0) PLUGINS.splice(i, 1);
  }
}

async function expectRejected(source: string): Promise<void> {
  const dir = repoWith(source, ['./my.ts']);
  const loaded = await loadExternalPlugins(dir);
  assert.equal(loaded.length, 0);
}

/** Rejection must be actionable — the warning names the failing field
 *  so the author fixes it instead of bisecting the export. Captures
 *  console.error for the load duration only. */
async function expectRejectedNaming(source: string, fieldPattern: RegExp): Promise<void> {
  const dir = repoWith(source, ['./my.ts']);
  const warnings: string[] = [];
  const orig = console.error;
  console.error = (msg: unknown) => warnings.push(String(msg));
  try {
    const loaded = await loadExternalPlugins(dir);
    assert.equal(loaded.length, 0);
  } finally {
    console.error = orig;
  }
  assert.ok(
    warnings.some(w => fieldPattern.test(w)),
    `expected a rejection warning matching ${fieldPattern}, got: ${warnings.join(' | ') || '(none)'}`
  );
}

describe('plugin registry', () => {
  test('names are unique', () => {
    const names = PLUGINS.map(p => p.name);
    assert.equal(new Set(names).size, names.length);
  });

  test('every plugin has a runnable entry and a summary', () => {
    for (const p of PLUGINS) {
      assert.equal(typeof p.run, 'function', p.name);
      assert.ok(p.summary.length > 0, p.name);
    }
  });

  test('skill references point at existing skill dirs', () => {
    // skills/ is two levels up from packages/cli/src in the workspace
    for (const p of PLUGINS) {
      if (p.skill) {
        assert.ok(p.skill.length > 0 && !p.skill.includes('..'), `${p.name} skill`);
      }
    }
  });

  test('plugins lists itself', () => {
    assert.ok(PLUGINS.some(p => p.name === 'plugins'));
  });

  test('every visible plugin is grouped or meta (specs/cli)', () => {
    // the blessed top-level row — operator/meta commands that stay
    // ungrouped by design; everything else must claim a group.
    // `wait` is dep-plane, not thread-plane — a `mesh` membership
    // would shadow the mesh host's own `wait` subcommand (the
    // specs/cross-repo spelling is `bro wait`, top-level by design)
    // `router` is a NAMESPACE HOST, not a capability member — it
    // mounts the brouter sub-CLI (models|clients|client|ask|acp) as
    // one plugin, so it has no members of its own to group (bro-3bplj)
    const META = new Set(['check', 'setup', 'doctor', 'plugins', 'clients', 'wait', 'router']);
    const groups = pluginGroups();
    for (const p of PLUGINS) {
      if (p.hidden || p.external) continue;
      if (p.group) {
        assert.ok(groups.get(p.group)?.includes(p), `${p.name} claims unknown group '${p.group}'`);
      } else {
        assert.ok(
          META.has(p.name) || p.aliasOf,
          `${p.name} is visible but ungrouped and not meta/alias`
        );
      }
    }
  });

  test('group names collide only with their host plugin', () => {
    for (const [group, members] of pluginGroups()) {
      const host = members.find(p => p.name === group);
      // a plugin named like the group must claim that group — an
      // unrelated same-named plugin would silently shadow members
      const stray = PLUGINS.find(p => p.name === group && p.group !== group);
      assert.equal(stray, undefined, `plugin '${group}' exists but does not host its group`);
      assert.ok(host === undefined || host.name === group, `group '${group}' host mismatch`);
    }
  });

  test('aliasOf targets resolve to real plugins', () => {
    for (const p of PLUGINS) {
      if (!p.aliasOf) continue;
      const target = p.aliasOf.split(' ')[0];
      assert.ok(
        PLUGINS.some(q => q.name === target),
        `${p.name} aliases '${p.aliasOf}' — no plugin '${target}'`
      );
    }
  });

  test('configKey ⟺ configSchema pairing', () => {
    for (const p of PLUGINS) {
      if (p.configKey) {
        assert.equal(
          typeof p.configSchema,
          'function',
          `${p.name} declares configKey without configSchema`
        );
      } else {
        assert.equal(p.configSchema, undefined, `${p.name} has configSchema but no configKey`);
      }
    }
  });

  test('pluginConfigSections maps configKey to its schema', () => {
    const sections = pluginConfigSections();
    assert.equal(typeof sections.act, 'function');
    assert.equal(typeof sections.sync, 'function');
    assert.equal(typeof sections.debt, 'function');
    assert.equal(sections.hooks, undefined);
  });

  test('every registered section declares a jsonSchema (bro-d9dmx)', () => {
    // the emitted document is only as complete as the registry — a
    // schema-less section silently drops out of doctor AND the schema
    const missing = Object.entries(pluginConfigSections())
      .filter(([, s]) => typeof s === 'function' && s.jsonSchema === undefined)
      .map(([k]) => k);
    assert.deepEqual(missing, []);
  });
});

describe('assertMutableConfig', () => {
  function withForce(v: string | undefined, fn: () => void): void {
    const prev = process.env.BRO_CONFIG_FORCE;
    if (v === undefined) delete process.env.BRO_CONFIG_FORCE;
    else process.env.BRO_CONFIG_FORCE = v;
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env.BRO_CONFIG_FORCE;
      else process.env.BRO_CONFIG_FORCE = prev;
    }
  }

  test('a clean config passes', () => {
    const dir = tmpDir('bro-mut-');
    writeFileSync(join(dir, 'bro.config.json'), JSON.stringify({ sdd: { mode: 'gate' } }));
    withForce(undefined, () => assert.doesNotThrow(() => assertMutableConfig(dir)));
  });

  function thrown(fn: () => void): ConfigPolicyError {
    try {
      fn();
    } catch (err) {
      return err as ConfigPolicyError;
    }
    throw new Error('expected ConfigPolicyError, nothing threw');
  }

  test('invalid policy config throws ConfigPolicyError carrying diagnostics', () => {
    const dir = tmpDir('bro-mut-');
    writeFileSync(join(dir, 'bro.config.json'), JSON.stringify({ sdd: { mode: 'gtae' } }));
    withForce(undefined, () => {
      const err = thrown(() => assertMutableConfig(dir));
      assert.ok(err instanceof ConfigPolicyError);
      assert.ok(err.diagnostics.some(d => d.path === 'sdd.mode'));
      assert.match(err.message, /sdd\.mode/);
      assert.match(err.message, /BRO_CONFIG_FORCE/);
    });
  });

  test('invalid operator config does not gate — it is doctor material', () => {
    const dir = tmpDir('bro-mut-');
    writeFileSync(
      join(dir, 'bro.config.json'),
      JSON.stringify({ providers: { x: { type: 'bogus' } }, fleet: { maxConcurrent: '1' } })
    );
    withForce(undefined, () => assert.doesNotThrow(() => assertMutableConfig(dir)));
  });

  test('plugin policy sections gate too — a malformed guard.def throws', () => {
    const dir = tmpDir('bro-mut-');
    writeFileSync(
      join(dir, 'bro.config.json'),
      JSON.stringify({
        guard: { defs: [{ name: 'x', when: { on: ['not-an-event'] }, say: 'hi' }] },
      })
    );
    withForce(undefined, () => {
      const err = thrown(() => assertMutableConfig(dir));
      assert.ok(err instanceof ConfigPolicyError);
      assert.ok(err.diagnostics.some(d => d.key === 'guard'));
    });
  });

  test('BRO_CONFIG_FORCE=1 is the deliberate escape hatch', () => {
    const dir = tmpDir('bro-mut-');
    writeFileSync(join(dir, 'bro.config.json'), JSON.stringify({ sdd: { mode: 'gtae' } }));
    withForce('1', () => assert.doesNotThrow(() => assertMutableConfig(dir)));
  });
});

describe('loadExternalPlugins', () => {
  test('a .ts default-export plugin registers and is marked external', async () => {
    const dir = repoWith(
      `export default { name: 'hello', summary: 'test plugin', run: () => {} }`,
      ['./my.ts']
    );
    const loaded = await loadExternalPlugins(dir);
    try {
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0].name, 'hello');
      assert.equal(loaded[0].external, true);
      assert.ok(PLUGINS.some(p => p.name === 'hello'));
    } finally {
      unload(loaded);
    }
  });

  test('non-plugin exports and missing modules warn+skip', async () => {
    const dir = repoWith(`export default { not: 'a plugin' }`, ['./my.ts', './missing.ts']);
    const loaded = await loadExternalPlugins(dir);
    assert.equal(loaded.length, 0);
  });

  test('a name colliding with a builtin is skipped', async () => {
    const dir = repoWith(`export default { name: 'debt', summary: 'shadow', run: () => {} }`, [
      './my.ts',
    ]);
    const loaded = await loadExternalPlugins(dir);
    try {
      assert.equal(loaded.length, 0);
      assert.equal(PLUGINS.filter(p => p.name === 'debt').length, 1);
    } finally {
      unload(loaded);
    }
  });

  test('a name colliding with a reserved word is skipped', async () => {
    const dir = repoWith(`export default { name: 'list', summary: 'shadow', run: () => {} }`, [
      './my.ts',
    ]);
    const loaded = await loadExternalPlugins(dir, undefined, new Set(['list', 'task']));
    assert.equal(loaded.length, 0);
  });

  test('wrong-typed optional fields reject the export', async () => {
    await expectRejected(
      `export default { name: 'bad1', summary: 'x', run: () => {}, configSchema: 'nope' }`
    );
  });

  test('a non-string deprecated field rejects the export', async () => {
    await expectRejected(
      `export default { name: 'badd', summary: 'x', run: () => {}, deprecated: true }`
    );
  });

  test('a string deprecated field registers and survives on the plugin', async () => {
    const dir = repoWith(
      `export default { name: 'shim', summary: 'x', run: () => {}, deprecated: 'use bro newcmd' }`,
      ['./my.ts']
    );
    const loaded = await loadExternalPlugins(dir);
    try {
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0].deprecated, 'use bro newcmd');
    } finally {
      unload(loaded);
    }
  });

  test('a non-integer or non-positive planVersion rejects the export', async () => {
    for (const v of ['"1"', '1.5', '0', 'true']) {
      const dir = repoWith(
        `export default { name: 'badv', summary: 'x', run: () => {}, planVersion: ${v} }`,
        ['./my.ts']
      );
      const loaded = await loadExternalPlugins(dir);
      assert.equal(loaded.length, 0, `planVersion: ${v}`);
    }
  });

  test('external configKey cannot shadow an owned section', async () => {
    const dir = repoWith(
      `export default { name: 'evil', summary: 'x', run: () => {}, configKey: 'act', configSchema: () => ({}) }`,
      ['./my.ts']
    );
    const loaded = await loadExternalPlugins(dir);
    try {
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0].configKey, undefined);
      assert.equal(loaded[0].configSchema, undefined);
      // the builtin act schema still owns the section
      assert.equal(pluginConfigSections().act, (await import('@broject/core')).actSection);
    } finally {
      unload(loaded);
    }
  });

  test('relative specs cannot escape the repo root', async () => {
    const dir = repoWith(null, []);
    // the escape target must exist — resolve() throws on missing files
    // before the containment check runs
    writeFileSync(
      join(dir, '..', 'bro-outside-plugin.ts'),
      `export default { name: 'evil2', summary: 'x', run: () => {} }`
    );
    const loaded = await loadExternalPlugins(dir, ['../bro-outside-plugin.ts']);
    assert.equal(loaded.length, 0);
  });

  test('whitespace around specs is trimmed by config normalization', async () => {
    const dir = repoWith(`export default { name: 'ws', summary: 'x', run: () => {} }`, [
      '  ./my.ts  ',
    ]);
    const loaded = await loadExternalPlugins(dir);
    try {
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0].name, 'ws');
    } finally {
      unload(loaded);
    }
  });
});

describe('bro run — plan routing', () => {
  function planFile(body: string): string {
    const dir = tmpDir('bro-plan-');
    const file = join(dir, 'plan.toml');
    writeFileSync(file, body);
    return file;
  }

  test('kind routes to the plugin, schema validates, runPlan executes', async () => {
    const seen: string[] = [];
    const plugin = {
      name: 'testplan',
      summary: 't',
      run: () => {},
      planSchema: (doc: unknown) => ({ v: (doc as { plan: { v: string } }).plan.v }),
      runPlan: (p: unknown) => {
        seen.push((p as { v: string }).v);
      },
    };
    PLUGINS.push(plugin);
    try {
      await runPlanFile([planFile('kind = "testplan"\n[plan]\nv = "ok"')]);
      assert.deepEqual(seen, ['ok']);
    } finally {
      PLUGINS.splice(PLUGINS.indexOf(plugin), 1);
    }
  });

  test('unknown kind errors with the known list', async () => {
    await assert.rejects(
      runPlanFile([planFile('kind = "nope"\n[plan]\nv = 1')]),
      /kind "nope" is unknown.*retrospect/
    );
  });

  test('kind naming a plan-less plugin errors distinctly', async () => {
    await assert.rejects(
      runPlanFile([planFile('kind = "cleanup"\n[plan]\nv = 1')]),
      /plugin "cleanup" does not accept plans/
    );
  });

  test('missing kind errors', async () => {
    await assert.rejects(runPlanFile([planFile('[plan]\nv = 1')]), /no kind field/);
  });

  test('bad TOML surfaces the file path', async () => {
    const file = planFile('kind = [');
    await assert.rejects(runPlanFile([file]), new RegExp(`${file}.*invalid TOML`));
  });

  test('a version pin above the plugin fails before schema and runPlan', async () => {
    const seen: string[] = [];
    const plugin = {
      name: 'testplan',
      summary: 't',
      run: () => {},
      planVersion: 1,
      planSchema: () => ({ v: 'x' }),
      runPlan: () => {
        seen.push('ran');
      },
    };
    PLUGINS.push(plugin);
    try {
      await assert.rejects(
        runPlanFile([planFile('kind = "testplan"\nversion = 2\n[plan]\nv = "ok"')]),
        /version: testplan schema v2 is newer than this bro understands \(latest v1\)/
      );
      assert.deepEqual(seen, []);
    } finally {
      PLUGINS.splice(PLUGINS.indexOf(plugin), 1);
    }
  });
});

describe('external plugin/connector validation', () => {
  const rejectionCases: Array<[string, string]> = [
    [
      'malformed connector matchDir is rejected',
      `export default { name: 'bad1', summary: 'x', run: () => {}, connectors: [{ name: 'c1', matchDir: 1 }] }`,
    ],
    [
      'malformed connector optInFacades rejected',
      `export default { name: 'bad2', summary: 'x', run: () => {}, connectors: [{ name: 'c2', optInFacades: 4 }] }`,
    ],
    [
      'connector with invalid optInFacades element rejected',
      `export default { name: 'bad3', summary: 'x', run: () => {}, connectors: [{ name: 'c3', optInFacades: ['badfac'] }] }`,
    ],
    [
      'argvPrefix elements must be strings',
      `export default { name: 'bad4', summary: 'x', run: () => {}, argvPrefix: ['ok', 123] }`,
    ],
    [
      'planSchema without runPlan rejected',
      `export default { name: 'bad5', summary: 'x', run: () => {}, planSchema: () => ({}) }`,
    ],
    [
      'runPlan without planSchema rejected',
      `export default { name: 'bad6', summary: 'x', run: () => {}, runPlan: () => {} }`,
    ],
    [
      'connector optIn must be boolean',
      `export default { name: 'bad7', summary: 'x', run: () => {}, connectors: [{ name: 'c7', optIn: 'yes' }] }`,
    ],
    [
      'connector callback field must be a function',
      `export default { name: 'bad8', summary: 'x', run: () => {}, connectors: [{ name: 'c8', matchRemote: 'x' }] }`,
    ],
    [
      'plugin group must be a string',
      `export default { name: 'bad9', summary: 'x', run: () => {}, group: 1 }`,
    ],
    [
      'plugin aliasOf must be a string',
      `export default { name: 'bad10', summary: 'x', run: () => {}, aliasOf: 2 }`,
    ],
    [
      'plugin hidden must be a boolean',
      `export default { name: 'bad11', summary: 'x', run: () => {}, hidden: 'y' }`,
    ],
    [
      'sparse optInFacades holes rejected',
      `export default { name: 'bad12', summary: 'x', run: () => {}, connectors: [{ name: 'c12', optInFacades: [,'tasks'] }] }`,
    ],
    [
      'connector activeIn must be a hook→modes record',
      `export default { name: 'bad13', summary: 'x', run: () => {}, connectors: [{ name: 'c13', activeIn: 5 }] }`,
    ],
    [
      'connector activeIn values must be mode lists',
      `export default { name: 'bad14', summary: 'x', run: () => {}, connectors: [{ name: 'c14', activeIn: { stopGate: 5 } }] }`,
    ],
    [
      'connector activeIn keys must be hook kinds',
      `export default { name: 'bad15', summary: 'x', run: () => {}, connectors: [{ name: 'c15', activeIn: { notAHook: ['code'] } }] }`,
    ],
    [
      'connector activeIn elements must be modes',
      `export default { name: 'bad16', summary: 'x', run: () => {}, connectors: [{ name: 'c16', activeIn: { stopGate: ['bogus'] } }] }`,
    ],
    [
      'sparse connector activeIn mode list rejected',
      `export default { name: 'bad17', summary: 'x', run: () => {}, connectors: [{ name: 'c17', activeIn: { stopGate: [,'code'] } }] }`,
    ],
    [
      'plugin external must be a boolean',
      `export default { name: 'bad18', summary: 'x', run: () => {}, external: 'yes' }`,
    ],
    [
      'sparse docs array holes rejected',
      `export default { name: 'bad19', summary: 'x', run: () => {}, docs: [, { name: 't', adapter: () => ({}) }] }`,
    ],
    [
      'inherited activeIn value is read the way dispatch reads it',
      `export default { name: 'bad20', summary: 'x', run: () => {}, connectors: [{ name: 'c20', activeIn: Object.create({ stopGate: 5 }) }] }`,
    ],
    [
      'docType aliases must be a string array',
      `export default { name: 'bad21', summary: 'x', run: () => {}, docs: [{ name: 't', adapter: () => ({}), aliases: 5 }] }`,
    ],
    [
      'docType scopes must be known scopes',
      `export default { name: 'bad22', summary: 'x', run: () => {}, docs: [{ name: 't', adapter: () => ({}), scopes: ['bogus'] }] }`,
    ],
    [
      'docType render must be a function',
      `export default { name: 'bad23', summary: 'x', run: () => {}, docs: [{ name: 't', adapter: () => ({}), render: 'x' }] }`,
    ],
    // the enumerable-key-count blind spot: a sparse hole plus an extra
    // own prop nets `keys.length === length`, and every() skips the
    // hole — each isDenseArray consumer gets the same regression case
    [
      'sparse argvPrefix hole hidden by an extra prop rejected',
      `export default { name: 'bad24', summary: 'x', run: () => {}, argvPrefix: Object.assign([,'ok'], { label: 'x' }) }`,
    ],
    [
      'sparse activeIn mode list hidden by an extra prop rejected',
      `export default { name: 'bad25', summary: 'x', run: () => {}, connectors: [{ name: 'c25', activeIn: { stopGate: Object.assign([,'code'], { label: 'x' }) } }] }`,
    ],
    [
      'sparse docType aliases hole hidden by an extra prop rejected',
      `export default { name: 'bad26', summary: 'x', run: () => {}, docs: [{ name: 't', adapter: () => ({}), aliases: Object.assign([,'al'], { tag: 1 }) }] }`,
    ],
    [
      'sparse docType scopes hole hidden by an extra prop rejected',
      `export default { name: 'bad27', summary: 'x', run: () => {}, docs: [{ name: 't', adapter: () => ({}), scopes: Object.assign([,'project'], { tag: 1 }) }] }`,
    ],
  ];

  for (const [title, source] of rejectionCases) {
    test(title, async () => {
      await expectRejected(source);
    });
  }

  // field-naming diagnostics — the rejection tells the author WHICH
  // field failed, not just that the export "is not a BroPlugin"
  const namingCases: Array<[string, string, RegExp]> = [
    [
      'rejection names connector matchDir',
      `export default { name: 'diag1', summary: 'x', run: () => {}, connectors: [{ name: 'd1', matchDir: 1 }] }`,
      /connectors\[0\]\.matchDir/,
    ],
    [
      'rejection names connector optInFacades',
      `export default { name: 'diag2', summary: 'x', run: () => {}, connectors: [{ name: 'd2', optInFacades: 4 }] }`,
      /connectors\[0\]\.optInFacades/,
    ],
    [
      'rejection names argvPrefix',
      `export default { name: 'diag3', summary: 'x', run: () => {}, argvPrefix: [1] }`,
      /argvPrefix/,
    ],
    [
      'rejection names the missing half of a schema pair',
      `export default { name: 'diag4', summary: 'x', run: () => {}, configKey: 'x' }`,
      /configSchema/,
    ],
    [
      'rejection names connector activeIn',
      `export default { name: 'diag5', summary: 'x', run: () => {}, connectors: [{ name: 'd5', activeIn: { stopGate: 5 } }] }`,
      /connectors\[0\]\.activeIn\.stopGate/,
    ],
    [
      'rejection names the docs index and field',
      `export default { name: 'diag6', summary: 'x', run: () => {}, docs: [{ name: 't', adapter: () => ({}), aliases: 5 }] }`,
      /docs\[0\]\.aliases/,
    ],
    [
      'rejection names the inherited activeIn key dispatch would read',
      `export default { name: 'diag7', summary: 'x', run: () => {}, connectors: [{ name: 'd7', activeIn: Object.create({ stopGate: 5 }) }] }`,
      /connectors\[0\]\.activeIn\.stopGate/,
    ],
  ];
  for (const [title, source, pattern] of namingCases) {
    test(title, async () => {
      await expectRejectedNaming(source, pattern);
    });
  }

  test('valid plugin with valid connectors still registers', async () => {
    const dir = repoWith(
      `export default { name: 'good1', summary: 'x', run: () => {}, connectors: [{ name: 'gc1', matchRemote: () => true, optInFacades: ['tasks'], optIn: true }] }`,
      ['./my.ts']
    );
    const loaded = await loadExternalPlugins(dir);
    try {
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0].name, 'good1');
    } finally {
      unload(loaded);
    }
  });

  test('connector declaring optInFacades + activeIn registers', async () => {
    const dir = repoWith(
      `export default { name: 'good2', summary: 'x', run: () => {}, connectors: [{ name: 'gc2', optIn: true, optInFacades: ['tasks', 'ledger'], activeIn: { stopGate: ['code', 'review'], sessionStart: ['observe'] } }] }`,
      ['./my.ts']
    );
    const loaded = await loadExternalPlugins(dir);
    try {
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0].name, 'good2');
    } finally {
      unload(loaded);
    }
  });

  test('a plugin carrying a valid doc type registers', async () => {
    const dir = repoWith(
      `export default { name: 'good4', summary: 'x', run: () => {}, docs: [{ name: 'dcs', aliases: ['dc'], scopes: ['project'], adapter: () => ({}) }] }`,
      ['./my.ts']
    );
    const loaded = await loadExternalPlugins(dir);
    try {
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0].docs?.[0]?.name, 'dcs');
    } finally {
      unload(loaded);
    }
  });

  test('a null-prototype activeIn map still registers', async () => {
    const dir = repoWith(
      `const ai = Object.create(null); ai.stopGate = ['code']; export default { name: 'good5', summary: 'x', run: () => {}, connectors: [{ name: 'gc5', activeIn: ai }] }`,
      ['./my.ts']
    );
    const loaded = await loadExternalPlugins(dir);
    try {
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0].name, 'good5');
    } finally {
      unload(loaded);
    }
  });

  test('dense arrays carrying extra non-index props still register', async () => {
    // extra own props are not elements — dispatch only ever reads
    // indices (spread/includes/index access), the same contract the
    // docs/connectors/optInFacades loops already hold
    const dir = repoWith(
      `export default { name: 'good6', summary: 'x', run: () => {}, argvPrefix: Object.assign(['pfx'], { label: 'x' }), connectors: [{ name: 'gc6', activeIn: { stopGate: Object.assign(['code'], { tag: 1 }) } }], docs: [{ name: 'dt6', aliases: Object.assign(['a6'], { tag: 1 }), scopes: ['project'], adapter: () => ({}) }] }`,
      ['./my.ts']
    );
    const loaded = await loadExternalPlugins(dir);
    try {
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0].name, 'good6');
      assert.equal(loaded[0].argvPrefix?.[0], 'pfx');
    } finally {
      unload(loaded);
    }
  });
});

describe('TypeScript↔runtime consistency (spec bro-l8c4f.1)', () => {
  // the runtime half of the contract: objects TypeScript accepts
  // (every built-in plugin/connector IS a typed BroPlugin/Connector)
  // must produce no validation problem — the checks reject malformed
  // shapes, never valid ones
  test('every built-in plugin passes external validation', () => {
    for (const p of PLUGINS) {
      assert.equal(pluginExportProblem(p), undefined, `plugin "${p.name}"`);
    }
  });

  test('every registered connector passes validation', () => {
    for (const c of connectors()) {
      assert.equal(connectorProblem(c, `connector "${c.name}"`), undefined);
    }
  });
});
