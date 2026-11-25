import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

import { describe, test } from 'node:test';
import {
  installClient,
  isBroAdapter,
  type MutateOpts,
  pluginRows,
  runPluginsCommand,
  scopesOf,
  uninstallClient,
} from './plugins.ts';
import { tmpDir } from './testrepo.ts';

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

function assertBundleMatches(dir: string): void {
  const files = ['index.ts', 'tui.tsx', 'rpc.ts'];
  for (const file of files) {
    assert.equal(
      readFileSync(join(dir, file), 'utf8'),
      readFileSync(join(repoRoot, 'plugins/opencode/bro', file), 'utf8')
    );
  }
  assert.match(readFileSync(join(dir, 'tui.tsx'), 'utf8'), /from\s+['"]\.\/rpc\.ts['"]/);
  for (const skill of ['sdd', 'act']) {
    assert.equal(
      readFileSync(join(dir, 'skills', skill, 'SKILL.md'), 'utf8'),
      readFileSync(join(repoRoot, 'skills', skill, 'SKILL.md'), 'utf8')
    );
  }
}

type ClientFixture = {
  cwd: string;
  opts: MutateOpts;
  globalPath: string;
  localPath: string;
};

type ClientMatrix = {
  client: 'opencode' | 'kilo';
  fixture: () => ClientFixture;
  assertInstalled: (path: string) => void;
};

function registerClientMatrix(config: ClientMatrix): void {
  const { client, fixture: makeFixture, assertInstalled } = config;

  test(`${client} install materializes the global plugin; a second run reports current`, () => {
    const f = makeFixture();
    const out = installClient(client, ['global', 'local'], f.opts);
    assert.deepEqual(
      out.map(o => o.action),
      ['installed']
    );
    assert.match(out[0]!.note ?? '', /without dedupe/);
    assertInstalled(f.globalPath);
    assert.ok(!existsSync(f.localPath));

    const again = installClient(client, ['global', 'local'], f.opts);
    assert.deepEqual(
      again.map(o => o.action),
      ['current']
    );
  });

  test(`${client} list reports an installed global plugin`, () => {
    const f = makeFixture();
    installClient(client, ['global'], f.opts);
    const row = pluginRows(f.cwd, f.opts.env).find(
      r => r.client === client && r.scope === 'global'
    );
    assert.equal(row!.state, 'installed');
  });

  test(`${client} uninstall removes the plugin`, () => {
    const f = makeFixture();
    installClient(client, ['global'], f.opts);
    const out = uninstallClient(client, ['global'], f.opts);
    assert.equal(out[0]!.action, 'removed');
    assert.ok(!existsSync(f.globalPath));
  });

  test(`${client} refuses a foreign file without --force`, () => {
    const f = makeFixture();
    mkdirSync(dirname(f.globalPath), { recursive: true });
    writeFileSync(f.globalPath, '// someone else\n');
    const out = installClient(client, ['global'], f.opts);
    assert.equal(out[0]!.action, 'refused');
    assert.equal(readFileSync(f.globalPath, 'utf8'), '// someone else\n');
  });

  test(`${client} dry-run writes nothing`, () => {
    const f = makeFixture();
    const out = installClient(client, ['global', 'local'], { ...f.opts, dryRun: true });
    assert.deepEqual(
      out.map(o => o.action),
      ['would-install']
    );
    assert.match(out[0]!.note ?? '', /without dedupe/);
    assert.ok(!existsSync(f.globalPath));
    assert.ok(!existsSync(f.localPath));
  });

  test(`${client} explicit --local installs the project copy`, () => {
    const f = makeFixture();
    const out = installClient(client, ['local'], f.opts);
    assert.deepEqual(
      out.map(o => o.action),
      ['installed']
    );
    assertInstalled(f.localPath);
    assert.ok(!existsSync(f.globalPath));
  });
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
  test('install materializes the v2 catalog plugin; a second run reports current', () => {
    const f = fixture();
    // bare install collapses to one scope — opencode 2.3.0 loads plugin
    // modules from both scopes without dedupe, identical id `bro`
    // double-registers hooks/tools/commands/RPC (bro-b7mae, verified
    // with `opencode run` probe plugins)
    const out = installClient('opencode', ['global', 'local'], f.opts);
    assert.deepEqual(
      out.map(o => `${o.action}:${o.path}`),
      [`installed:${f.globalDir}`]
    );
    assert.match(out[0]!.note ?? '', /without dedupe/);
    // the catalog plugin is ONE directory of three modules — the server
    // entrypoint, the TUI half and the contract they share. Install
    // ships the bundled catalog bytes, not the adapter sources: the
    // sources import workspace packages a host runtime cannot resolve.
    const shipped = readFileSync(join(repoRoot, 'plugins/opencode/bro/index.ts'), 'utf8');
    const shippedTui = readFileSync(join(repoRoot, 'plugins/opencode/bro/tui.tsx'), 'utf8');
    const shippedRpc = readFileSync(join(repoRoot, 'plugins/opencode/bro/rpc.ts'), 'utf8');
    assert.equal(readFileSync(join(f.globalDir, 'index.ts'), 'utf8'), shipped);
    assert.equal(readFileSync(join(f.globalDir, 'tui.tsx'), 'utf8'), shippedTui);
    assert.equal(readFileSync(join(f.globalDir, 'rpc.ts'), 'utf8'), shippedRpc);
    // the TUI half's own `./rpc.ts` import resolves inside the directory
    assert.match(shippedTui, /from\s+['"]\.\/rpc\.ts['"]/);
    // the embedded skills tree materializes beside the modules — the
    // plugin's collectBroSkills reads `<bundle>/skills/` first, so an
    // installed copy registers bro's skills instead of stumbling onto a
    // foreign skills/ dir (bro-tswwr)
    const shippedSkill = readFileSync(join(repoRoot, 'skills', 'sdd', 'SKILL.md'), 'utf8');
    assert.equal(
      readFileSync(join(f.globalDir, 'skills', 'sdd', 'SKILL.md'), 'utf8'),
      shippedSkill
    );
    assert.equal(
      readFileSync(join(f.globalDir, 'skills', 'act', 'SKILL.md'), 'utf8'),
      readFileSync(join(repoRoot, 'skills', 'act', 'SKILL.md'), 'utf8')
    );
    assert.ok(!existsSync(f.localDir));

    const again = installClient('opencode', ['global', 'local'], f.opts);
    assert.deepEqual(
      again.map(o => o.action),
      ['current']
    );
  });

  test('opencode install converges a dual-scope state — the loser is removed', () => {
    const f = fixture();
    // seed BOTH scopes the way an old installer left them — installClient
    // itself converges now, so the second copy is planted by hand
    installClient('opencode', ['global'], f.opts);
    cpSync(f.globalDir, f.localDir, { recursive: true });
    assert.ok(existsSync(join(f.globalDir, 'index.ts')));
    assert.ok(existsSync(join(f.localDir, 'index.ts')));

    const out = installClient('opencode', ['global', 'local'], f.opts);
    assert.deepEqual(
      out.map(o => `${o.action}:${o.scope}`),
      ['current:global', 'removed:local']
    );
    assert.ok(existsSync(join(f.globalDir, 'index.ts')));
    assert.ok(!existsSync(f.localDir));
  });

  /** sentinel-bearing but differing content — a stale/edited adapter */
  const staleAdapter = '// older bro build\nexport default {id:"bro",server:BroPlugin}\n';

  test('the omp client installs into the agent extensions dir', () => {
    const f = fixture();
    // omp's agent dir is the user profile's config root — the fixture
    // must not write the real one
    const agentDir = join(f.opts.env.XDG_CONFIG_HOME!, 'omp-agent');
    f.opts.env.PI_CODING_AGENT_DIR = agentDir;

    // bare install collapses to global — omp loads project+global copies
    // of the same extension without dedupe (bro-b7mae), same as pi
    const out = installClient('omp', ['global', 'local'], f.opts);
    const globalPath = join(agentDir, 'extensions', 'bro.ts');
    const localPath = join(f.cwd, '.omp', 'extensions', 'bro.ts');
    assert.deepEqual(
      out.map(o => `${o.action}:${o.path}`),
      [`installed:${globalPath}`]
    );
    assert.match(out[0]!.note ?? '', /without dedupe/);
    // the shipped adapter carries bro's ownership sentinel
    assert.ok(isBroAdapter(readFileSync(globalPath, 'utf8')));
    assert.ok(!existsSync(localPath));

    const again = installClient('omp', ['global', 'local'], f.opts);
    assert.deepEqual(
      again.map(o => o.action),
      ['current']
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
    // convergence removed the losing scope's stale copy — the host
    // must never be left holding two (bro-b7mae)
    assert.equal(
      pluginRows(f.cwd, f.opts.env)
        .filter(r => r.client === 'opencode')
        .map(r => `${r.scope}:${r.state}`)
        .join(','),
      'global:installed,local:absent'
    );
    assert.ok(!existsSync(join(f.localDir, 'index.ts')));
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
    // bare install collapses to global (bro-b7mae) — the local scope's
    // stale loose modules are still swept by convergence because
    // opencode would keep loading them alongside the global plugin
    assert.deepEqual(
      out.map(o => `${o.action}:${o.path}`),
      [
        `installed:${f.globalDir}`,
        `removed:${f.globalPath}`,
        `removed:${f.globalCliPath}`,
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
    // bare install collapses to one scope (bro-b7mae) — dry-run reports
    // the single would-install and still writes nothing
    const out = installClient('opencode', ['global', 'local'], { ...f.opts, dryRun: true });
    assert.deepEqual(
      out.map(o => o.action),
      ['would-install']
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
    // bare install collapses to global — pi cannot dedupe project+global
    // copies of the same extension (bro-b7mae); the note says why
    const out = installClient('pi', ['global', 'local'], f.opts);
    assert.deepEqual(
      out.map(o => o.action),
      ['installed']
    );
    assert.match(out[0]!.note ?? '', /without dedupe/);
    const piGlobal = join(f.opts.env.PI_CODING_AGENT_DIR!, 'extensions', 'bro.ts');
    assert.ok(existsSync(piGlobal));
    assert.ok(!existsSync(join(f.cwd, '.pi', 'extensions', 'bro.ts')));
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

  test('pi explicit --local still installs the project copy', () => {
    const f = fixture();
    const out = installClient('pi', ['local'], f.opts);
    assert.deepEqual(
      out.map(o => o.action),
      ['installed']
    );
    const piLocal = join(f.cwd, '.pi', 'extensions', 'bro.ts');
    assert.ok(existsSync(piLocal));
    assert.ok(!existsSync(join(f.opts.env.PI_CODING_AGENT_DIR!, 'extensions', 'bro.ts')));
  });

  test('pi bare install refreshes an existing local copy instead of adding global', () => {
    const f = fixture();
    installClient('pi', ['local'], f.opts);
    const out = installClient('pi', ['global', 'local'], f.opts);
    // the scope that already holds bro wins — refreshing it beats
    // creating the colliding twin the collapse exists to prevent
    assert.deepEqual(
      out.map(o => `${o.action}:${o.path}`),
      [`current:${join(f.cwd, '.pi', 'extensions', 'bro.ts')}`]
    );
    assert.match(out[0]!.note ?? '', /only the local-scope copy/);
    assert.ok(!existsSync(join(f.opts.env.PI_CODING_AGENT_DIR!, 'extensions', 'bro.ts')));
  });

  test('pi install converges an opposite-scope bro copy', () => {
    const f = fixture();
    // seed a project copy first, then install global-only — convergence
    // removes the colliding local copy rather than leaving the host
    // with two loaded extensions (bro-b7mae)
    installClient('pi', ['local'], f.opts);
    const out = installClient('pi', ['global'], f.opts);
    assert.equal(out[0]!.action, 'installed');
    assert.deepEqual(
      out.map(o => `${o.action}:${o.scope}`),
      ['installed:global', 'removed:local']
    );
    assert.ok(!existsSync(join(f.cwd, '.pi', 'extensions', 'bro.ts')));
  });

  test('omp bare install collapses to global like pi', () => {
    const f = fixture();
    const out = installClient('omp', ['global', 'local'], f.opts);
    assert.deepEqual(
      out.map(o => o.action),
      ['installed']
    );
    assert.match(out[0]!.note ?? '', /without dedupe/);
    // ompAgentDir honors PI_CODING_AGENT_DIR as an override — the fixture
    // sets it, so the global target lands under the same sandboxed dir
    assert.ok(existsSync(join(f.opts.env.PI_CODING_AGENT_DIR!, 'extensions', 'bro.ts')));
  });
});

/** kilo's file-plugin surface is the scanned `plugin/` directory —
 *  <XDG>/kilo/plugin/bro.ts globally, .kilo/plugin/bro.ts locally.
 *  kilo.json's `plugin` array does NOT honor file paths (verified
 *  against kilo 7.8.x), so no manifest step exists. */
function kiloFixture(): {
  cwd: string;
  opts: MutateOpts;
  globalPath: string;
  localPath: string;
} {
  const cwd = tmpDir('bro-plugins-kilo-cwd-');
  const xdg = tmpDir('bro-plugins-kilo-xdg-');
  const opts: MutateOpts = {
    dryRun: false,
    force: false,
    cwd,
    env: { ...process.env, XDG_CONFIG_HOME: xdg },
  };
  return {
    cwd,
    opts,
    globalPath: join(xdg, 'kilo', 'plugin', 'bro.ts'),
    localPath: join(cwd, '.kilo', 'plugin', 'bro.ts'),
  };
}

describe('plugins install/uninstall/list — kilo', () => {
  test('global install materializes the module into the scanned plugin dir', () => {
    const f = kiloFixture();
    const out = installClient('kilo', ['global'], f.opts);
    assert.equal(out[0]!.action, 'installed');
    // materialized content is the bundled catalog adapter — the src
    // tree imports @broject/adapter-core, unresolvable in kilo
    const shipped = readFileSync(join(repoRoot, 'plugins/kilo/bro/bro.ts'), 'utf8');
    assert.equal(readFileSync(f.globalPath, 'utf8'), shipped);
    // kilo.json is never touched — the plugin/ dir is the whole contract
    assert.ok(
      !existsSync(join(f.opts.env.XDG_CONFIG_HOME!, 'kilo', 'kilo.json')),
      'kilo.json must not be created for a file-plugin install'
    );
  });

  test('local install writes .kilo/plugin', () => {
    const f = kiloFixture();
    const out = installClient('kilo', ['local'], f.opts);
    assert.equal(out[0]!.action, 'installed');
    assert.equal(
      readFileSync(f.localPath, 'utf8'),
      readFileSync(join(repoRoot, 'plugins/kilo/bro/bro.ts'), 'utf8')
    );
  });

  test('re-install reports current', () => {
    const f = kiloFixture();
    installClient('kilo', ['global'], f.opts);
    const again = installClient('kilo', ['global'], f.opts);
    assert.equal(again[0]!.action, 'current');
  });

  test('list reports an installed global module', () => {
    const f = kiloFixture();
    installClient('kilo', ['global'], f.opts);
    const row = pluginRows(f.cwd, f.opts.env).find(
      r => r.client === 'kilo' && r.scope === 'global'
    );
    assert.equal(row!.state, 'installed');
  });

  test('uninstall removes the module', () => {
    const f = kiloFixture();
    installClient('kilo', ['global'], f.opts);
    const out = uninstallClient('kilo', ['global'], f.opts);
    assert.equal(out[0]!.action, 'removed');
    assert.ok(!existsSync(f.globalPath));
  });

  test('a foreign file holding the slot is refused without --force', () => {
    const f = kiloFixture();
    mkdirSync(join(f.opts.env.XDG_CONFIG_HOME!, 'kilo', 'plugin'), { recursive: true });
    writeFileSync(f.globalPath, '// someone else\n');
    const out = installClient('kilo', ['global'], f.opts);
    assert.equal(out[0]!.action, 'refused');
    assert.equal(readFileSync(f.globalPath, 'utf8'), '// someone else\n');
  });

  test('--dry-run writes nothing', () => {
    const f = kiloFixture();
    // bare install collapses to one scope — kilo loads project+global
    // plugin copies without dedupe (verified on 7.8.27, bro-b7mae)
    const out = installClient('kilo', ['global', 'local'], { ...f.opts, dryRun: true });
    assert.deepEqual(
      out.map(o => o.action),
      ['would-install']
    );
    assert.match(out[0]!.note ?? '', /without dedupe/);
    assert.ok(!existsSync(f.globalPath));
    assert.ok(!existsSync(f.localPath));
  });

  test('kilo bare install lands global only; explicit --local still works', () => {
    const f = kiloFixture();
    const out = installClient('kilo', ['global', 'local'], f.opts);
    assert.deepEqual(
      out.map(o => o.action),
      ['installed']
    );
    assert.ok(existsSync(f.globalPath));
    assert.ok(!existsSync(f.localPath));

    const f2 = kiloFixture();
    const local = installClient('kilo', ['local'], f2.opts);
    assert.deepEqual(
      local.map(o => o.action),
      ['installed']
    );
    assert.ok(existsSync(f2.localPath));
    assert.ok(!existsSync(f2.globalPath));
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
