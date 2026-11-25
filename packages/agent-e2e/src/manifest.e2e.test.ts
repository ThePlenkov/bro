/** Manifest-host hook matrix — claude/codex/cursor/devin have no
 *  command slot (AGT-2…5): their `/bro`-equivalent contract is
 *  `hooks.json` → `hooks/run.sh <event>` → `bro hooks <event>`.
 *
 *  Each leg materializes the host's own run.sh into a fixture plugin
 *  root — far enough from the checkout that CLI resolution falls to
 *  PATH, where FakeBro answers — seeds an ACTIVE session mode (the
 *  default `observe` mode fast-paths lifecycle events to a shell
 *  no-op by design), then fires every bro event the host's hooks.json
 *  declares.
 *
 *  The invariant: identical `hook <event>` journal entries with the
 *  stdin payload intact, on every host. */

import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeEnv, REPO, run, which } from './env.ts';
import { FakeBro } from './mocks/bro.ts';

interface ManifestHost {
  name: string;
  /** The run.sh artifact this host ships. */
  runSh: string;
  /** The hooks.json whose declared events drive the legs. */
  hooksJson: string;
  /** The plugin-root env var the host exports (spool host label). */
  rootEnv: string;
}

const HOSTS: ManifestHost[] = [
  {
    name: 'claude',
    runSh: 'hooks/run.sh',
    hooksJson: 'plugins/claude/bro/hooks/hooks.json',
    rootEnv: 'CLAUDE_PLUGIN_ROOT',
  },
  {
    name: 'codex',
    runSh: 'plugins/codex/bro/hooks/run.sh',
    hooksJson: 'plugins/codex/bro/hooks/hooks.json',
    // codex exports the generic PLUGIN_ROOT — run.sh's host detection
    // keys the session-mode file off it
    rootEnv: 'PLUGIN_ROOT',
  },
  {
    name: 'cursor',
    runSh: 'plugins/cursor/bro/hooks/run.sh',
    hooksJson: 'plugins/cursor/bro/hooks/hooks.json',
    rootEnv: 'CURSOR_PLUGIN_ROOT',
  },
  {
    name: 'devin',
    runSh: 'plugins/devin/bro/hooks/run.sh',
    hooksJson: 'plugins/devin/bro/hooks.json',
    rootEnv: 'DEVIN_PLUGIN_ROOT',
  },
];

/** The canonical bro hook events — anything else in a hooks.json
 *  (codex's `resolves`, matchers) is host plumbing, not a bro event. */
const BRO_EVENTS = new Set([
  'session-start',
  'prompt-submit',
  'pre-tool',
  'post-tool',
  'pre-compact',
  'post-compaction',
  'permission',
  'stop',
]);

/** Every `run.sh <event>` the host's hooks.json wires, deduped. */
function declaredEvents(hooksJsonPath: string): string[] {
  const raw = readFileSync(join(REPO, hooksJsonPath), 'utf8');
  const events = new Set<string>();
  for (const m of raw.matchAll(/run\.sh\\?"\s+([a-z-]+)/g)) {
    if (BRO_EVENTS.has(m[1]!)) {
      events.add(m[1]!);
    }
  }
  return [...events];
}

for (const host of HOSTS) {
  test(`${host.name}: every declared hook event reaches bro hooks (manifest matrix)`, {
    skip: which('sh') === null && 'sh not on PATH',
  }, async () => {
    const e = makeEnv();
    const fb = new FakeBro().install(e);
    const sid = `e2e-${host.name}`;

    // materialize the plugin root the way the host's installer would:
    // <root>/hooks/run.sh — far from the checkout so the dist rung
    // misses and PATH (FakeBro) answers
    const pluginRoot = join(e.root, `${host.name}-plugin`);
    const hooksDir = join(pluginRoot, 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    const runShPath = join(hooksDir, 'run.sh');
    copyFileSync(join(REPO, host.runSh), runShPath);
    chmodSync(runShPath, 0o755);

    // an ACTIVE session mode — the default `observe` resolves lifecycle
    // events to a shell no-op (specs/bro-izpyk.2.md). The mode file is
    // the hook-time truth: <state>/bro/sessions/<host>-<sid>.mode
    const stateDir = join(e.env.XDG_STATE_HOME as string, 'bro', 'sessions');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, `${host.name}-${sid}.mode`), 'code\n');

    const events = declaredEvents(host.hooksJson);
    assert.ok(events.length >= 2, `${host.name}: hooks.json declared almost nothing: ${events}`);

    const env = {
      ...e.env,
      [host.rootEnv]: pluginRoot,
      // cwd inside the opted-in fixture project — run.sh's opt-in walk
      // anchors on $PWD. No DEVIN_PROJECT_DIR: it would corrupt codex's
      // bare-PLUGIN_ROOT host detection (labels the session `devin`,
      // so the seeded mode file never matches)
    };
    for (const event of events) {
      const payload = JSON.stringify({
        session_id: sid,
        hook_event_name: event,
        tool_name: 'bash',
        tool_input: { command: 'ls' },
      });
      const res = await run('sh', [runShPath, event], {
        cwd: e.proj,
        env,
        input: payload,
        timeoutMs: 30_000,
      });
      // run.sh's contract is fail-open: exit 0 always, output only
      // when the event has an opinion
      assert.equal(
        res.code,
        0,
        `${host.name} ${event}: run.sh exited ${res.code}: ${res.stderr.slice(-300)}`
      );
    }

    const journal = fb.journal();
    for (const event of events) {
      const hit = journal.find(
        en =>
          en.kind === 'hook' &&
          en.event === event &&
          (en.payload as { session_id?: string })?.session_id === sid
      );
      assert.ok(
        hit,
        `${host.name}: FakeBro never saw \`bro hooks ${event}\` — journal: ${JSON.stringify(journal.map(j => ({ k: j.kind, e: j.event })))}`
      );
    }
  });
}
