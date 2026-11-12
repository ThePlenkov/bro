import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { tmpDir } from './testrepo.ts';
import {
  installClient,
  isBroAdapter,
  pluginRows,
  runPluginsCommand,
  scopesOf,
  uninstallClient,
  type MutateOpts,
} from './plugins.ts';

/** tmp cwd (non-repo → local target lands under it) + tmp XDG home. */
function fixture(): {
  cwd: string;
  opts: MutateOpts;
  globalDir: string;
  localDir: string;
  globalPath: string;
  localPath: string;
  globalCliPath: string;
  localCliPath: string;
} {
  const cwd = tmpDir('bro-plugins-cwd-');
  const xdg = tmpDir('bro-plugins-xdg-');
  const opts: MutateOpts = {
    dryRun: false,
    force: false,
    cwd,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: xdg,
      // keep the pi global target inside the fixture — the default
      // (~/.pi/agent) is the real home dir, and tests must never write it
      PI_CODING_AGENT_DIR: join(xdg, 'pi-agent'),
    },
  };
  return {
    cwd,
    opts,
    // the v2 catalog plugin — one directory, three modules
    globalDir: join(xdg, 'opencode', 'plugins', 'bro'),
    localDir: join(cwd, '.opencode', 'plugins', 'bro'),
    // the v1-era loose modules
    globalPath: join(xdg, 'opencode', 'plugins', 'bro.ts'),
    localPath: join(cwd, '.opencode', 'plugins', 'bro.ts'),
    globalCliPath: join(xdg, 'opencode', 'plugins', 'bro-cli.ts'),
    localCliPath: join(cwd, '.opencode', 'plugins', 'bro-cli.ts'),
  };
}

describe('scopesOf', () => {
  test('no scope flag means both', () => {
    assert.deepEqual(scopesOf(['opencode']), ['global', 'local']);
    assert.deepEqual(scopesOf(['opencode', '--global', '--local']), ['global', 'local']);
  });

  test('a single flag narrows', () => {
    assert.deepEqual(scopesOf(['opencode', '--global']), ['global']);
    assert.deepEqual(scopesOf(['--local', 'opencode']), ['local']);
  });
});

describe('the client argument', () => {
  test('a mistyped flag is a usage error, not a silent drop', () => {
    // `--locla` used to vanish: every flag was dropped while the client
    // name was read, so the command ran with the wrong scope and said
    // nothing about the typo
    assert.throws(
      () => runPluginsCommand(['install', 'opencode', '--locla'], []),
      (err: unknown) => {
        const e = err as { code?: number; message?: string };
        assert.equal(e.code, 2);
        assert.match(String(e.message), /unknown option --locla/);
        return true;
      }
    );
  });

  test('the known flags are accepted', () => {
    const f = fixture();
    const cwd = process.cwd();
    const xdg = process.env.XDG_CONFIG_HOME;
    process.chdir(f.cwd);
    process.env.XDG_CONFIG_HOME = join(f.cwd, 'xdg');
    try {
      // a dry run mutates nothing, so the command returns without writing
      runPluginsCommand(['install', 'opencode', '--dry-run', '--global'], []);
    } finally {
      process.chdir(cwd);
      if (xdg === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = xdg;
      }
    }
    assert.equal(existsSync(join(f.cwd, 'xdg')), false);
  });
});

describe('isBroAdapter', () => {
  test('recognizes the shipped module (source and bundle shape)', () => {
    const src = join(repoRoot, 'packages/agent-plugins/opencode/src/opencode.ts');
    assert.ok(isBroAdapter(readFileSync(src, 'utf8')));
    // tsdown output: quotes collapse, identifiers survive
    // modern (Plugin.define) and legacy (server:) bundle shapes
    assert.ok(isBroAdapter('export default Plugin.define({id:"bro",setup:s})\n'));
    assert.ok(isBroAdapter('export default {id:"bro",server:BroPlugin}\n'));
    assert.ok(!isBroAdapter('export default {id:"other",server:x}\n'));
    assert.ok(!isBroAdapter('// hand-written empty plugin\n'));
  });

  test('recognizes the kilo module', () => {
    assert.ok(
      isBroAdapter(readFileSync(join(repoRoot, 'packages/agent-plugins/kilo/src/kilo.ts'), 'utf8'))
    );
  });

  test('recognizes the pi extension sentinel', () => {
    // the shipped adapter is the generated bundle (plugins/pi/bro/bro.ts);
    // the source binding carries the same sentinel
    const src = join(repoRoot, 'packages/agent-plugins/pi/src/pi.ts');
    assert.ok(isBroAdapter(readFileSync(src, 'utf8')));
    assert.ok(isBroAdapter('const adapter={id:"bro",kind:"pi-extension"}\n'));
    assert.ok(!isBroAdapter('export default function x(){}\n'));
  });

  test('recognizes the omp extension sentinel', () => {
    const src = join(repoRoot, 'packages/agent-plugins/omp/src/omp.ts');
    assert.ok(isBroAdapter(readFileSync(src, 'utf8')));
    assert.ok(isBroAdapter('const adapter={id:"bro",kind:"omp-extension"}\n'));
    // the kind token must be there too — the id claim alone is not ours
    assert.ok(!isBroAdapter('export default {id:"bro"}\n'));
  });

  test('recognizes the opencode TUI module', () => {
    const src = join(repoRoot, 'packages/agent-plugins/opencode/src/tui.tsx');
    assert.ok(isBroAdapter(readFileSync(src, 'utf8')));
    assert.ok(isBroAdapter('export default {id:"bro.cli",kind:"opencode-tui"}\n'));
    // the cli id alone does not suffice — the kind token must be there too
    assert.ok(!isBroAdapter('export default {id:"bro.cli",setup(){}}\n'));
  });

  test('recognizes the opencode RPC contract module', () => {
    const src = join(repoRoot, 'packages/agent-plugins/opencode/src/rpc.ts');
    assert.ok(isBroAdapter(readFileSync(src, 'utf8')));
  });

  test('recognizes a stale-era adapter whose identifier moved (retro bro-g2f9)', () => {
    // the shipped kilo adapter once defaulted `server: bro` — the old
    // `server: BroPlugin` regex read that as foreign and refused updates
    assert.ok(isBroAdapter('export default {id:"bro",server:bro}\n'));
    assert.ok(isBroAdapter('export const adapter = {id: "bro", server: whatever}\n'));
    // still not ours: another plugin's id, or bro-adjacent with no
    // family token
    assert.ok(!isBroAdapter('export default {id:"other",server:bro}\n'));
    assert.ok(!isBroAdapter('export default {id:"bro"}\n'));
  });

  test('the sentinel alone does not own a slot — the id claim is required', () => {
    // review finding: a foreign module that merely mentions the marker
    // must not be overwritten without --force
    assert.ok(isBroAdapter('// bro-adapter\nexport default {id:"bro"}\n'));
    assert.ok(!isBroAdapter('// bro-adapter\nexport default {}\n'));
    assert.ok(!isBroAdapter('// mentions bro-adapter in prose\nexport const x = 1\n'));
  });
});

describe('plugins install/uninstall/list', () => {
  test('install materializes the v2 catalog plugin in both scopes; a second run reports current', () => {
    const f = fixture();
    const out = installClient('opencode', ['global', 'local'], f.opts);
    assert.deepEqual(
      out.map(o => `${o.action}:${o.path}`),
      [`installed:${f.globalDir}`, `installed:${f.localDir}`]
    );
    // the catalog plugin is ONE directory of three modules — the server
    // entrypoint, the TUI half and the contract they share
    const shipped = readFileSync(
      join(repoRoot, 'packages/agent-plugins/opencode/src/opencode.ts'),
      'utf8'
    );
    const shippedTui = readFileSync(
      join(repoRoot, 'packages/agent-plugins/opencode/src/tui.tsx'),
      'utf8'
    );
    const shippedRpc = readFileSync(
      join(repoRoot, 'packages/agent-plugins/opencode/src/rpc.ts'),
      'utf8'
    );
    assert.equal(readFileSync(join(f.globalDir, 'index.ts'), 'utf8'), shipped);
    assert.equal(readFileSync(join(f.globalDir, 'tui.tsx'), 'utf8'), shippedTui);
    assert.equal(readFileSync(join(f.globalDir, 'rpc.ts'), 'utf8'), shippedRpc);
    // the server's own `./rpc.ts` import resolves inside the directory
    assert.match(shipped, /from\s+['"]\.\/rpc\.ts['"]/);

    const again = installClient('opencode', ['global', 'local'], f.opts);
    assert.deepEqual(
      again.map(o => o.action),
      ['current', 'current']
    );
  });

  /** sentinel-bearing but differing content — a stale/edited adapter */
  const staleAdapter = '// older bro build\nexport default {id:"bro",server:BroPlugin}\n';

  test('the omp client installs into the agent extensions dir', () => {
    const f = fixture();
    // omp's agent dir is the user profile's config root — the fixture
    // must not write the real one
    const agentDir = join(f.opts.env.XDG_CONFIG_HOME!, 'omp-agent');
    f.opts.env.PI_CODING_AGENT_DIR = agentDir;

    const out = installClient('omp', ['global', 'local'], f.opts);
    const globalPath = join(agentDir, 'extensions', 'bro.ts');
    const localPath = join(f.cwd, '.omp', 'extensions', 'bro.ts');
    assert.deepEqual(
      out.map(o => `${o.action}:${o.path}`),
      [`installed:${globalPath}`, `installed:${localPath}`]
    );
    // the shipped adapter carries bro's ownership sentinel
    assert.ok(isBroAdapter(readFileSync(globalPath, 'utf8')));

    const again = installClient('omp', ['global', 'local'], f.opts);
    assert.deepEqual(
      again.map(o => o.action),
      ['current', 'current']
    );
  });

  test('install on a stale module reports updated; list shows stale first', () => {
    const f = fixture();
    mkdirSync(f.globalDir, { recursive: true });
    writeFileSync(join(f.globalDir, 'index.ts'), staleAdapter);
    mkdirSync(f.localDir, { recursive: true });
    writeFileSync(join(f.localDir, 'index.ts'), staleAdapter);

    const rows = pluginRows(f.cwd, f.opts.env).filter(r => r.client === 'opencode');
    assert.deepEqual(
      rows.map(r => `${r.client}:${r.scope}:${r.state}`),
      ['opencode:global:stale', 'opencode:local:stale']
    );
    assert.deepEqual(
      pluginRows(f.cwd, f.opts.env)
        .filter(r => r.client === 'pi')
        .map(r => `${r.client}:${r.scope}:${r.state}`),
      ['pi:global:absent', 'pi:local:absent']
    );

    const out = installClient('opencode', ['global'], f.opts);
    assert.equal(out[0]!.action, 'updated');
    assert.equal(
      pluginRows(f.cwd, f.opts.env)
        .filter(r => r.client === 'opencode')
        .map(r => `${r.scope}:${r.state}`)
        .join(','),
      'global:installed,local:stale'
    );
  });

  test('the v1-era loose modules are removed when the catalog plugin lands', () => {
    // a stale module in the plugins dir is still LOADED by opencode — it
    // would shadow the current layout
    const f = fixture();
    mkdirSync(join(f.opts.env.XDG_CONFIG_HOME!, 'opencode', 'plugins'), { recursive: true });
    writeFileSync(f.globalPath, staleAdapter);
    writeFileSync(
      f.globalCliPath,
      '// older bro build\nexport default {id:"bro.cli",kind:"opencode-tui"}\n'
    );
    mkdirSync(join(f.cwd, '.opencode', 'plugins'), { recursive: true });
    writeFileSync(f.localPath, staleAdapter);
    writeFileSync(
      f.localCliPath,
      '// older bro build\nexport default {id:"bro.cli",kind:"opencode-tui"}\n'
    );

    const out = installClient('opencode', ['global', 'local'], f.opts);
    assert.deepEqual(
      out.map(o => `${o.action}:${o.path}`),
      [
        `installed:${f.globalDir}`,
        `removed:${f.globalPath}`,
        `removed:${f.globalCliPath}`,
        `installed:${f.localDir}`,
        `removed:${f.localPath}`,
        `removed:${f.localCliPath}`,
      ]
    );
    assert.ok(!existsSync(f.globalPath));
    assert.ok(!existsSync(f.localCliPath));
    // the catalog plugin itself is untouched by the legacy sweep
    assert.ok(existsSync(join(f.globalDir, 'index.ts')));
  });

  test('a foreign loose module is left alone', () => {
    const f = fixture();
    mkdirSync(join(f.opts.env.XDG_CONFIG_HOME!, 'opencode', 'plugins'), { recursive: true });
    writeFileSync(f.globalPath, '// user-written plugin, no bro sentinel');
    const out = installClient('opencode', ['global'], f.opts);
    assert.deepEqual(
      out.map(o => o.action),
      ['installed']
    );
    assert.equal(readFileSync(f.globalPath, 'utf8'), '// user-written plugin, no bro sentinel');
  });

  test('a stale adapter with a moved identifier still updates without --force', () => {
    // retro bro-g2f9: the shipped kilo adapter once wrote `server: bro`;
    // the old ownership regex wanted `server: BroPlugin` literally and
    // refused the slot as foreign
    const f = fixture();
    mkdirSync(f.globalDir, { recursive: true });
    writeFileSync(
      join(f.globalDir, 'index.ts'),
      '// older bro build\nexport default {id:"bro",server:bro}\n'
    );
    const out = installClient('opencode', ['global'], f.opts);
    assert.equal(out[0]!.action, 'updated');
  });

  test('--dry-run writes nothing', () => {
    const f = fixture();
    const out = installClient('opencode', ['global', 'local'], { ...f.opts, dryRun: true });
    assert.deepEqual(
      out.map(o => o.action),
      ['would-install', 'would-install']
    );
    assert.ok(!existsSync(f.globalDir));
    assert.ok(!existsSync(f.localDir));
  });

  test('install refuses a foreign file at our slot without --force', () => {
    const f = fixture();
    mkdirSync(f.localDir, { recursive: true });
    writeFileSync(join(f.localDir, 'index.ts'), '// user-written plugin, no bro sentinel');
    const out = installClient('opencode', ['local'], f.opts);
    assert.equal(out[0]!.action, 'refused');
    assert.equal(
      readFileSync(join(f.localDir, 'index.ts'), 'utf8'),
      '// user-written plugin, no bro sentinel'
    );
    const forced = installClient('opencode', ['local'], { ...f.opts, force: true });
    assert.equal(forced[0]!.action, 'updated');
  });

  test('uninstall removes ours, skips absent, refuses foreign without --force', () => {
    const f = fixture();
    installClient('opencode', ['global'], f.opts);
    mkdirSync(f.localDir, { recursive: true });
    writeFileSync(join(f.localDir, 'index.ts'), '// foreign plugin');
    const refused = uninstallClient('opencode', ['global', 'local'], f.opts);
    assert.deepEqual(
      refused.map(o => o.action),
      // the global catalog plugin is removed, then the foreign local
      // module refuses
      ['removed', 'refused']
    );
    assert.ok(!existsSync(f.globalDir));
    assert.ok(existsSync(join(f.localDir, 'index.ts')));

    const forced = uninstallClient('opencode', ['local'], { ...f.opts, force: true });
    assert.equal(forced[0]!.action, 'removed');
    assert.ok(!existsSync(join(f.localDir, 'index.ts')));

    const gone = uninstallClient('opencode', ['global', 'local'], f.opts);
    assert.deepEqual(
      gone.map(o => o.action),
      ['absent', 'absent']
    );
  });

  test('uninstall refuses a stale/edited adapter without --force', () => {
    const f = fixture();
    mkdirSync(f.globalDir, { recursive: true });
    writeFileSync(join(f.globalDir, 'index.ts'), staleAdapter);
    const out = uninstallClient('opencode', ['global'], f.opts);
    assert.equal(out[0]!.action, 'refused');
    assert.match(out[0]!.note ?? '', /stale or edited/);
    const forced = uninstallClient('opencode', ['global'], { ...f.opts, force: true });
    assert.equal(forced[0]!.action, 'removed');
  });

  test('uninstall keeps a module of the user that lives beside ours', () => {
    const f = fixture();
    installClient('opencode', ['global'], f.opts);
    writeFileSync(join(f.globalDir, 'mine.ts'), '// user-written');
    const out = uninstallClient('opencode', ['global'], f.opts);
    assert.equal(out[0]!.action, 'removed');
    // the directory stays — the user's own module is not ours to delete
    assert.ok(existsSync(join(f.globalDir, 'mine.ts')));
    assert.ok(!existsSync(join(f.globalDir, 'index.ts')));
  });

  test('list reflects install state per scope', () => {
    const f = fixture();
    const rowsFor = (client: string) =>
      pluginRows(f.cwd, f.opts.env)
        .filter(r => r.client === client)
        .map(r => `${r.client}:${r.scope}:${r.state}`);
    assert.deepEqual(rowsFor('opencode'), ['opencode:global:absent', 'opencode:local:absent']);
    assert.deepEqual(rowsFor('pi'), ['pi:global:absent', 'pi:local:absent']);
    installClient('opencode', ['local'], f.opts);
    assert.deepEqual(rowsFor('opencode'), ['opencode:global:absent', 'opencode:local:installed']);
    assert.deepEqual(rowsFor('pi'), ['pi:global:absent', 'pi:local:absent']);
  });

  test('pi install lands in .pi/extensions/ and the agent dir', () => {
    const f = fixture();
    const out = installClient('pi', ['global', 'local'], f.opts);
    assert.deepEqual(
      out.map(o => o.action),
      ['installed', 'installed']
    );
    const piGlobal = join(f.opts.env.PI_CODING_AGENT_DIR!, 'extensions', 'bro.ts');
    const piLocal = join(f.cwd, '.pi', 'extensions', 'bro.ts');
    assert.ok(existsSync(piGlobal));
    assert.ok(existsSync(piLocal));
    // the installed adapter is a self-contained bundle — pi's jiti loads
    // it with no node_modules to resolve against, and it must still be
    // recognizable as bro's own
    const installed = readFileSync(piGlobal, 'utf8');
    assert.ok(isBroAdapter(installed));
    assert.deepEqual(
      [...installed.matchAll(/from\s+['"](\.[^'"]*)['"]/g)].map(m => m[1] ?? ''),
      []
    );
  });
});

/** kilo adds a manifest step on global: a file:/// entry in
 *  <XDG>/kilo/kilo.json's plugin[] next to the materialized module. */
function kiloFixture(): {
  cwd: string;
  opts: MutateOpts;
  globalPath: string;
  localPath: string;
  manifestPath: string;
  manifest(): Record<string, unknown>;
  entry: string;
} {
  const cwd = tmpDir('bro-plugins-kilo-cwd-');
  const xdg = tmpDir('bro-plugins-kilo-xdg-');
  const opts: MutateOpts = {
    dryRun: false,
    force: false,
    cwd,
    env: { ...process.env, XDG_CONFIG_HOME: xdg },
  };
  const globalPath = join(xdg, 'kilo', 'bro', 'bro.ts');
  const manifestPath = join(xdg, 'kilo', 'kilo.json');
  return {
    cwd,
    opts,
    globalPath,
    localPath: join(cwd, '.kilo', 'plugin', 'bro.ts'),
    manifestPath,
    manifest: () => JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>,
    entry: pathToFileURL(globalPath).href,
  };
}

describe('plugins install/uninstall/list — kilo', () => {
  test('global install materializes the module and registers file:/// in kilo.json', () => {
    const f = kiloFixture();
    const out = installClient('kilo', ['global'], f.opts);
    assert.equal(out[0]!.action, 'installed');
    assert.match(out[0]!.note ?? '', /registered/);
    // materialized content is the shipped adapter source verbatim
    const shipped = readFileSync(join(repoRoot, 'packages/agent-plugins/kilo/src/kilo.ts'), 'utf8');
    assert.equal(readFileSync(f.globalPath, 'utf8'), shipped);
    // a fresh manifest is created with kilo's own $schema line
    const m = f.manifest();
    assert.deepEqual(m.plugin, [f.entry]);
    assert.equal(m.$schema, 'https://app.kilo.ai/config.json');
  });

  test('local install writes .kilo/plugin and touches no manifest', () => {
    const f = kiloFixture();
    const out = installClient('kilo', ['local'], f.opts);
    assert.equal(out[0]!.action, 'installed');
    assert.equal(
      readFileSync(f.localPath, 'utf8'),
      readFileSync(join(repoRoot, 'packages/agent-plugins/kilo/src/kilo.ts'), 'utf8')
    );
    assert.ok(!existsSync(f.manifestPath));
  });

  test('re-install reports current once registered; dedupes the entry', () => {
    const f = kiloFixture();
    installClient('kilo', ['global'], f.opts);
    const again = installClient('kilo', ['global'], f.opts);
    assert.equal(again[0]!.action, 'current');
    assert.deepEqual(f.manifest().plugin, [f.entry]);
  });

  test('a current-but-unregistered file registers and reports updated', () => {
    const f = kiloFixture();
    installClient('kilo', ['global'], f.opts);
    writeFileSync(f.manifestPath, '{}\n'); // drop the registration
    const out = installClient('kilo', ['global'], f.opts);
    assert.equal(out[0]!.action, 'updated');
    assert.match(out[0]!.note ?? '', /registered/);
    assert.deepEqual(f.manifest().plugin, [f.entry]);
  });

  test('registration preserves existing kilo.json fields and entries', () => {
    const f = kiloFixture();
    mkdirSync(join(f.opts.env.XDG_CONFIG_HOME!, 'kilo'), { recursive: true });
    writeFileSync(
      f.manifestPath,
      `${JSON.stringify({ plugin: ['file:///other/plugin.ts'], permission: { bash: 'allow' } }, null, 2)}\n`
    );
    installClient('kilo', ['global'], f.opts);
    const m = f.manifest();
    assert.deepEqual(m.plugin, ['file:///other/plugin.ts', f.entry]);
    assert.deepEqual(m.permission, { bash: 'allow' });
  });

  test('rewriting kilo.json preserves a restrictive file mode', () => {
    const f = kiloFixture();
    mkdirSync(join(f.opts.env.XDG_CONFIG_HOME!, 'kilo'), { recursive: true });
    writeFileSync(f.manifestPath, '{}\n');
    chmodSync(f.manifestPath, 0o600);
    installClient('kilo', ['global'], f.opts);
    assert.equal(statSync(f.manifestPath).mode & 0o777, 0o600);
    assert.deepEqual(f.manifest().plugin, [f.entry]);
  });

  test('list reports an unregistered global module as stale', () => {
    const f = kiloFixture();
    installClient('kilo', ['global'], f.opts);
    writeFileSync(f.manifestPath, '{}\n');
    const row = pluginRows(f.cwd, f.opts.env).find(
      r => r.client === 'kilo' && r.scope === 'global'
    );
    assert.equal(row!.state, 'stale');
    installClient('kilo', ['global'], f.opts);
    assert.equal(
      pluginRows(f.cwd, f.opts.env).find(r => r.client === 'kilo' && r.scope === 'global')!.state,
      'installed'
    );
  });

  test('uninstall removes the module and the kilo.json entry', () => {
    const f = kiloFixture();
    installClient('kilo', ['global'], f.opts);
    const out = uninstallClient('kilo', ['global'], f.opts);
    assert.equal(out[0]!.action, 'removed');
    assert.ok(!existsSync(f.globalPath));
    assert.deepEqual(f.manifest().plugin, []);
  });

  test('uninstall cleans a dangling kilo.json entry when the file is absent', () => {
    const f = kiloFixture();
    mkdirSync(join(f.opts.env.XDG_CONFIG_HOME!, 'kilo'), { recursive: true });
    writeFileSync(f.manifestPath, `${JSON.stringify({ plugin: [f.entry] })}\n`);
    const out = uninstallClient('kilo', ['global'], f.opts);
    assert.equal(out[0]!.action, 'absent');
    assert.match(out[0]!.note ?? '', /dangling/);
    assert.deepEqual(f.manifest().plugin, []);
  });

  test('a refused file keeps its registration', () => {
    const f = kiloFixture();
    installClient('kilo', ['global'], f.opts);
    // a hand edit makes the adapter "stale or edited" — refuses without --force
    writeFileSync(f.globalPath, `// touched\n${readFileSync(f.globalPath, 'utf8')}`);
    const out = uninstallClient('kilo', ['global'], f.opts);
    assert.equal(out[0]!.action, 'refused');
    assert.deepEqual(f.manifest().plugin, [f.entry]);
  });

  test('--dry-run writes neither module nor manifest', () => {
    const f = kiloFixture();
    const out = installClient('kilo', ['global', 'local'], { ...f.opts, dryRun: true });
    assert.deepEqual(
      out.map(o => o.action),
      ['would-install', 'would-install']
    );
    assert.ok(!existsSync(f.globalPath));
    assert.ok(!existsSync(f.localPath));
    assert.ok(!existsSync(f.manifestPath));
  });
});

describe('plugins --json', () => {
  test('prints the registry as data — the generator contract', () => {
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
    const orig = console.log;
    let printed = '';
    console.log = (s: unknown) => {
      printed += String(s);
    };
    try {
      runPluginsCommand(['--json'], plugins as never);
    } finally {
      console.log = orig;
    }
    const rows = JSON.parse(printed) as {
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
});
