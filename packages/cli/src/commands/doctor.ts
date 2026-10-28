/**
 * `bro doctor` — environment diagnostics. bro orchestrates gh + bd + git +
 * worktrees + spawned agents — external tools with independent failure
 * modes — and until now there was no diagnostic entrypoint when a setup
 * breaks.
 *
 *   bro doctor [--json]
 *
 * One line per probe: ✓ ok, ! warn, ✗ fail, - skipped. Exit 1 on any
 * failure; warnings pass. Probes are read-only — a broken tool reports as
 * a failing check, never as a crash.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import {
  bdTry,
  CONFIG_SECTION_LAYERS,
  connectors,
  CORE_CONFIG_SECTIONS,
  displayUrl,
  doltDirHealth,
  doltRemoteSrc,
  facade,
  facadeAuth,
  facadeName,
  fileTargetPath,
  gitCommonDir,
  gitTry,
  hasHelpFlag,
  isEnvName,
  janitorDidWork,
  janitorLine,
  listDoltRemotes,
  loadConfigLayers,
  pidAlive,
  printUsage,
  probeBdCompat,
  probeDoltRemote,
  PROVIDER_REGISTRY,
  runJanitor,
} from '@broject/core';
import type {
  BdCompat,
  BdProbe,
  ConfigDiagnostic,
  DoltHeadHealth,
  DoltRemote,
  ProviderEntry,
  ProviderSurface,
} from '@broject/core';
import { formatRigUri, parsePeer, rigFromRemoteUrl } from '@broject/mesh';
import {
  assertSonarHostTrusted,
  assertTokenSafeHost,
  CODACY_HOST,
  resolveCodesceneProject,
  resolveSonarProject,
  SourceSkipped,
} from '@broject/debt';
import { judgeConfig, synthesizedProviders } from '@broject/judge';
import type { JudgeConfig } from '@broject/judge';
import { broConfigDiagnostics, loadBroConfig, pluginConfigSections } from '../plugins.ts';
import { pluginRows } from './plugins.ts';
import { readStamp, stampAgo, stampSession } from './buildstamp.ts';
import {
  budgetLines,
  budgetSnapshotFor,
  loadAgentEnv,
  type AgentConnectorEnv,
  type BudgetSnapshot,
} from '../agent-connectors.ts';

export type DoctorStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
  /** remediation — only on warn/fail */
  hint?: string;
}

const check = (name: string, status: DoctorStatus, detail: string, hint?: string): DoctorCheck => ({
  name,
  status,
  detail,
  ...(hint ? { hint } : {}),
});

interface BinProbe {
  found: boolean;
  /** true only on ENOENT — a binary that exists but can't spawn (EACCES)
   *  or times out is present-but-broken; reporting it "not found" would
   *  send the user reinstalling a tool that's actually installed */
  missing?: boolean;
  version?: string;
  err?: string;
}

/** `--version` probe — the same PATH-is-the-contract lookup every bro
 *  shell-out uses. */
function probeBin(name: string): BinProbe {
  // PATH lookup is the contract (same as gh/bd/git) — biome keeps the
  // marker on the issue line only in the /* */-leading-statement form
  /* NOSONAR */ const p = spawnSync(name, ['--version'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (p.error) {
    const code = (p.error as NodeJS.ErrnoException).code;
    return { found: false, missing: code === 'ENOENT', err: p.error.message };
  }
  if (p.status !== 0) {
    return { found: false, err: (p.stderr ?? '').trim() || `exit ${p.status}` };
  }
  const m = /\d+(\.\d+)+/.exec(`${p.stdout ?? ''} ${p.stderr ?? ''}`);
  return { found: true, version: m?.[0] };
}

/** Present-but-broken vs absent — a spawn failure is never "not found". */
function binProblem(p: BinProbe): string {
  if (p.missing === true) {
    return 'not found';
  }
  const err = p.err ? ` (${p.err})` : '';
  return `not usable${err}`;
}

/** Repo root for dir, or null outside a worktree. */
function repoRoot(dir: string): string | null {
  const r = gitTry(['-C', dir, 'rev-parse', '--show-toplevel']);
  return r.code === 0 && r.out.trim() !== '' ? r.out.trim() : null;
}

function isDir(path: string): boolean {
  try {
    // throwIfNoEntry only swallows ENOENT — EACCES/ENOTDIR on a path
    // part still throws; an unreadable target is not a dir, never a
    // doctor abort
    return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
  } catch {
    return false;
  }
}

// --- individual probes ------------------------------------------------------

function checkNode(): DoctorCheck {
  // the real capability gate is type stripping (bro.config.ts loads via
  // createRequire), not the version number — same probe config.ts uses
  const ts = (process.features as { typescript?: unknown }).typescript;
  if (ts) {
    return check('node', 'ok', `v${process.versions.node}`);
  }
  return check(
    'node',
    'warn',
    `v${process.versions.node} — no native type stripping`,
    'bro.config.ts needs Node ≥22.18 — bro.config.json still works'
  );
}

function checkGh(): DoctorCheck {
  const gh = probeBin('gh');
  if (!gh.found) {
    return check('gh', 'fail', binProblem(gh), 'install the GitHub CLI — https://cli.github.com');
  }
  /* NOSONAR — PATH lookup is the contract */ const auth = spawnSync('gh', ['auth', 'status'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (auth.status !== 0) {
    return check(
      'gh',
      'fail',
      `${gh.version ?? 'present'} not authenticated`,
      'run `gh auth login`'
    );
  }
  return check('gh', 'ok', `${gh.version ?? 'present'} authed`);
}

/** Hooks replay run.sh's resolution order: local dist walking up from the
 *  plugin root → `bro` on PATH passing the `bro hooks` probe → npx
 *  fallback. Nothing resolving is a warn, not a fail — hooks fail open
 *  by design, so a broken chain degrades to silent no-ops, not errors. */
function checkHooks(dir: string): DoctorCheck {
  const envRoot =
    process.env.PLUGIN_ROOT ?? process.env.DEVIN_PLUGIN_ROOT ?? process.env.CLAUDE_PLUGIN_ROOT;
  let d = resolve(envRoot?.startsWith('/') ? envRoot : dir);
  for (;;) {
    const dist = join(d, 'packages', 'cli', 'dist', 'index.js');
    if (statSync(dist, { throwIfNoEntry: false })?.isFile()) {
      return check('hooks', 'ok', `resolves via local dist — ${dist}`);
    }
    const parent = dirname(d);
    if (parent === d) {
      break;
    }
    d = parent;
  }
  if (probeBin('bro').found) {
    // `bro hooks` with no event is a silent no-op — same probe run.sh runs
    /* NOSONAR — PATH lookup is the contract */ const probe = spawnSync('bro', ['hooks'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    });
    if (probe.status === 0) {
      return check('hooks', 'ok', 'resolves via `bro` on PATH');
    }
  }
  if (probeBin('npx').found) {
    return check(
      'hooks',
      'warn',
      'npx @broject/bro fallback only',
      'every lifecycle event pays the npx resolution — `npm i -g @broject/bro` or the agent plugin resolves locally'
    );
  }
  return check(
    'hooks',
    'warn',
    'no resolution — lifecycle hooks silently no-op',
    'install @broject/bro or the agent plugin to get session-start context and the stop gate'
  );
}

/** Devin's plugin lockfile — `<data>/devin/cli/plugins/lock.json`, the
 *  resolved-install list `devin plugins` maintains; the same base
 *  derivation devinLocksDir uses. An absent or unreadable file answers
 *  "nothing resolved" — duplicate wiring is then unprovable. */
function devinPluginLockfile(env: NodeJS.ProcessEnv): string {
  const xdg = env['XDG_DATA_HOME'];
  const base =
    xdg !== undefined && xdg.trim() !== ''
      ? xdg
      : join(
          env['HOME'] !== undefined && env['HOME'] !== '' ? env['HOME'] : homedir(),
          '.local',
          'share'
        );
  return join(base, 'devin', 'cli', 'plugins', 'lock.json');
}

/** A `bro` entry in the lockfile's resolved list — any source/scope
 *  counts: a resolved plugin's hooks register in Devin sessions. */
function broPluginResolved(lockfile: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(lockfile, 'utf8')) as { resolved?: unknown };
    return (
      Array.isArray(raw.resolved) && raw.resolved.some(r => isRecord(r) && r['name'] === 'bro')
    );
  } catch {
    return false;
  }
}

/** Bro-launcher signature inside a Devin hook command — run.sh or a
 *  `bro hooks …` invocation. Applied per event/handler so a chain that
 *  also wires foreign tooling can be scoped instead of dropped
 *  wholesale. */
const DEVIN_BRO_HOOK = /hooks\/run\.sh|bro(?:\.exe|\.cmd)?\s+hooks[\s"']/;

/** Every command a chain event's groups run — null when the shape is
 *  off-schema (non-array event value, group without a hooks list),
 *  which the caller counts as foreign rather than guess at what it
 *  holds. */
function devinChainCommands(groups: unknown): string[] | null {
  if (!Array.isArray(groups)) {
    return null;
  }
  const commands: string[] = [];
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group['hooks'])) {
      return null;
    }
    for (const h of group['hooks']) {
      const cmd = isRecord(h) ? h['command'] : undefined;
      commands.push(typeof cmd === 'string' ? cmd : '');
    }
  }
  return commands;
}

/** Which events carry a bro handler and whether the chain wires
 *  anything else — the two facts that pick the remediation (drop the
 *  file vs strip only the bro entries). Anything we cannot prove is a
 *  bro handler counts as foreign, so the hint never advises deleting
 *  handlers the check didn't recognize. null when the JSON won't
 *  parse: the caller falls back to the file-level signature and the
 *  safe hint. */
function devinChainShape(text: string): { broEvents: string[]; foreign: boolean } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw)) {
    return null;
  }
  const broEvents: string[] = [];
  let foreign = false;
  for (const [event, groups] of Object.entries(raw)) {
    if (DEVIN_BRO_HOOK.test(JSON.stringify(groups))) {
      broEvents.push(event);
    }
    const commands = devinChainCommands(groups);
    if (commands === null || commands.some(c => !DEVIN_BRO_HOOK.test(c))) {
      foreign = true;
    }
  }
  return { broEvents, foreign };
}

/** Duplicate Devin hook wiring (bro-36sx7.5) — a project-local bro
 *  chain plus a resolved `bro` plugin both register the same events, so
 *  each wired event spawns two launchers (the plugin copy exits early
 *  when the project chain owns the event — the spawn itself is the
 *  overhead the hooks-perf epic kills). Only chains carrying a bro
 *  signature collide: a .devin/hooks.v1.json wiring foreign tooling
 *  fires alongside the plugin, not against it. Warn, never fail — a
 *  lone project chain is legitimate wiring. The remediation preserves
 *  unrelated handlers: drop-file only when the chain is all-bro,
 *  strip-the-bro-entries otherwise. */
function devinWiringCheck(root: string | null): DoctorCheck {
  let text: string | null = null;
  if (root !== null) {
    try {
      text = readFileSync(join(root, '.devin', 'hooks.v1.json'), 'utf8');
    } catch {
      // absent or unreadable — no project chain
    }
  }
  if (text === null) {
    return check('hooks-wiring', 'ok', 'no project-local Devin hook chain');
  }
  const shape = devinChainShape(text);
  const hasBro = shape === null ? DEVIN_BRO_HOOK.test(text) : shape.broEvents.length > 0;
  if (!hasBro) {
    return check('hooks-wiring', 'ok', 'project-local Devin chain wires no bro hooks');
  }
  if (!broPluginResolved(devinPluginLockfile(process.env))) {
    return check(
      'hooks-wiring',
      'ok',
      '.devin/hooks.v1.json — sole bro wiring (no resolved bro plugin)'
    );
  }
  const detail =
    shape !== null
      ? `.devin/hooks.v1.json + resolved bro plugin — two hook launchers on every bro-wired event (${shape.broEvents.join(', ')})`
      : '.devin/hooks.v1.json + resolved bro plugin — two hook launchers on every bro-wired event';
  const hint =
    shape !== null && !shape.foreign
      ? 'drop .devin/hooks.v1.json — the plugin already wires bro (run.sh defers to a project chain while one exists)'
      : 'remove the bro hook entries from .devin/hooks.v1.json, keep the other handlers — the plugin already wires bro';
  return check('hooks-wiring', 'warn', detail, hint);
}

// --- self-build staleness (bro-s7vgd) --------------------------------------
// PATH-bro is commonly a symlink into a dev checkout's packages/cli/dist —
// merges move the checkout's HEAD but nothing rebuilds dist, so spawned
// agents and hooks silently run stale code (a convoy spawn skipped
// fleet.routing because dist predated #333). When the resolved `bro` — or
// the running entrypoint — lands in <checkout>/packages/cli/dist, compare
// the build stamp (freshest dist mtime) to the newest commit the checkout
// or its upstream knows.

interface DevDist {
  checkout: string;
  distDir: string;
  entry: string;
}

/** First `bro` executable PATH resolves — the binary spawns/hooks
 *  actually exec. Windows shims (.cmd/.exe) lead so the spawn target
 *  matches what a shell would pick. */
function pathBroBin(): string | null {
  const names = process.platform === 'win32' ? ['bro.cmd', 'bro.exe', 'bro'] : ['bro'];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const hit = dir === '' ? undefined : names.map(name => join(dir, name)).find(existsSync);
    if (hit !== undefined) {
      return hit;
    }
  }
  return null;
}

/** Realpath'd and deduped — a symlink into a dev checkout exposes
 *  itself; a dangling one contributes nothing. */
function realpathDedup(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    try {
      const r = realpathSync(p);
      if (!out.includes(r)) {
        out.push(r);
      }
    } catch {
      // dangling symlink — nothing resolvable to inspect
    }
  }
  return out;
}

/** `bro` as PATH resolves it — the binary spawns/hooks actually exec —
 *  plus the running entrypoint (doctor may run via npx while PATH-bro is
 *  the dev symlink). Realpath'd so the symlink into the checkout exposes
 *  itself; deduped since the two usually converge on one file. */
function broEntrypoints(): string[] {
  const raw: string[] = [];
  const onPath = pathBroBin();
  if (onPath !== null) {
    raw.push(onPath);
  }
  const self = process.argv[1];
  if (typeof self === 'string' && self !== '') {
    raw.push(self);
  }
  return realpathDedup(raw);
}

/** A file inside a bro dev checkout's packages/cli/dist, or null. The
 *  package.json name check keeps any other repo's same-shaped layout
 *  from posing as bro, and the repo-root check keeps a vendored copy
 *  inside another repo from being compared against that repo's HEAD. */
function devDistEntry(realPath: string): DevDist | null {
  const distDir = dirname(realPath);
  const cliDir = dirname(distDir);
  const packagesDir = dirname(cliDir);
  if (
    basename(distDir) !== 'dist' ||
    basename(cliDir) !== 'cli' ||
    basename(packagesDir) !== 'packages'
  ) {
    return null;
  }
  try {
    const pkg = JSON.parse(readFileSync(join(cliDir, 'package.json'), 'utf8')) as {
      name?: string;
    };
    if (pkg.name !== '@broject/bro') {
      return null;
    }
  } catch {
    return null;
  }
  const checkout = dirname(packagesDir);
  const root = repoRoot(checkout);
  try {
    if (root === null || realpathSync(root) !== realpathSync(checkout)) {
      return null;
    }
  } catch {
    return null;
  }
  return { checkout, distDir, entry: realPath };
}

/** Freshest mtime across dist's top level — the moment the last build
 *  finished. 0 when nothing readable: a dist that can't be stat'd can't
 *  be trusted either. */
function distStampMs(distDir: string): number {
  let newest = 0;
  for (const f of readdirSync(distDir, { withFileTypes: true })) {
    if (!f.isFile()) {
      continue;
    }
    const m = statSync(join(distDir, f.name), { throwIfNoEntry: false })?.mtimeMs ?? 0;
    if (m > newest) {
      newest = m;
    }
  }
  return newest;
}

/** When this clone last moved a ref — the mtime of its reflog file.
 *  The commit's %ct is committer-declared: a backdated upstream commit
 *  looks older than the dist built before it landed, and a future-dated
 *  one looks newer — the reflog append is the local, honest "checkout
 *  changed" signal (the entry timestamp itself is second-granularity,
 *  the file mtime is not). HEAD's log lives in the per-worktree git
 *  dir, ref logs in the common dir. 0 when the ref has no reflog. */
function refMovedMs(checkout: string, ref: string): number {
  const gd = gitTry([
    '-C',
    checkout,
    'rev-parse',
    ref === 'HEAD' ? '--git-dir' : '--git-common-dir',
  ]);
  if (gd.code !== 0) {
    return 0;
  }
  const name =
    ref === 'HEAD'
      ? 'HEAD'
      : gitTry(['-C', checkout, 'rev-parse', '--symbolic-full-name', ref]).out.trim();
  if (name === '') {
    return 0;
  }
  return (
    statSync(join(resolve(checkout, gd.out.trim()), 'logs', name), { throwIfNoEntry: false })
      ?.mtimeMs ?? 0
  );
}

function devDistCheck({ checkout, distDir, entry }: DevDist): DoctorCheck {
  const stamp = distStampMs(distDir);
  if (stamp === 0) {
    return check(
      'bro-dist',
      'warn',
      `${entry} — dist unreadable`,
      `rebuild: npm run build — ${checkout}`
    );
  }
  // HEAD covers a pulled checkout; @{u} catches "dist built before the
  // merge landed" even when a fetch moved the tracking ref ahead
  const refs = ['HEAD'];
  if (gitTry(['-C', checkout, 'rev-parse', '--verify', '--quiet', '@{u}']).code === 0) {
    refs.push('@{u}');
  }
  let newest: { ref: string; sha: string; ms: number } | null = null;
  for (const ref of refs) {
    const r = gitTry(['-C', checkout, 'show', '-s', '--format=%ct %h', ref]);
    if (r.code !== 0) {
      continue;
    }
    const [ct, sha] = r.out.trim().split(' ');
    const commitMs = Number(ct) * 1000;
    if (!Number.isFinite(commitMs) || commitMs <= 0) {
      continue;
    }
    // ref-move time is the signal; %ct is the fallback for ref-less moves
    const ms = refMovedMs(checkout, ref) || commitMs;
    if (newest === null || ms > newest.ms) {
      newest = { ref, sha: sha ?? ref, ms };
    }
  }
  if (newest === null) {
    return check('bro-dist', 'ok', `${checkout} — no resolvable commit, drift unproven`);
  }
  if (newest.ms > stamp) {
    return check(
      'bro-dist',
      'warn',
      `${entry} predates ${newest.ref} ${newest.sha} — spawned agents/hooks run stale code`,
      `rebuild: npm run build — ${checkout}`
    );
  }
  return check('bro-dist', 'ok', `${entry} covers ${newest.ref} ${newest.sha}`);
}

/** One row per dev checkout found — PATH-bro and a self-run dist can be
 *  different checkouts. None at all → a single ok row: an installed
 *  package has no HEAD to drift from. */
function selfDistChecks(): DoctorCheck[] {
  const seen = new Set<string>();
  const out: DoctorCheck[] = [];
  for (const real of broEntrypoints()) {
    const entry = devDistEntry(real);
    if (entry === null || seen.has(entry.checkout)) {
      continue;
    }
    seen.add(entry.checkout);
    out.push(devDistCheck(entry));
  }
  if (out.length === 0) {
    out.push(check('bro-dist', 'ok', 'no dev-checkout bro — nothing to rebuild'));
  }
  return out;
}

/** Top-level keys bro knows — anything else in bro.config.json is almost
 *  certainly a typo'd section that silently no-ops. */
function knownConfigKeys(): Set<string> {
  return new Set([
    '$schema',
    'stores',
    'store', // legacy v0.1.0
    'personality',
    'plugins',
    'pack',
    ...CORE_CONFIG_SECTIONS,
    ...Object.keys(pluginConfigSections()),
  ]);
}

function jsonKeysVerdict(path: string, name: string): DoctorCheck {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return check('config', 'ok', name); // probe already ok'd it — can't happen, stay honest anyway
  }
  const unknown = Object.keys(raw).filter(k => !knownConfigKeys().has(k));
  if (unknown.length === 0) {
    return check('config', 'ok', name);
  }
  return check(
    'config',
    'warn',
    `${name} — unknown keys: ${unknown.join(', ')}`,
    'unknown sections silently no-op — check for typos'
  );
}

/** Config probe: the effective layers plus per-section provenance and
 *  ownership warnings (spec: specs/bro-9vmx.md). Reads through
 *  loadConfigLayers — the same path loadConfig uses — so a file that
 *  throws during the real load reports broken here identically. */
function checkConfig(dir: string): DoctorCheck[] {
  const { layers, broken } = loadConfigLayers(dir);
  const checks: DoctorCheck[] = broken.map(file =>
    check(
      'config',
      'fail',
      `${basename(file)} failed to load (${file})`,
      'fix or remove it — a broken config silently falls back to jsonl-only stores'
    )
  );
  if (layers.length === 0) {
    checks.push(
      broken.length === 0
        ? check('config', 'ok', 'no bro.config — running on defaults')
        : check('config', 'warn', 'no usable config layer — running on defaults')
    );
    return checks;
  }
  checks.push(...configLayerChecks(layers, broken.length));
  checks.push(...configOwnershipChecks(layers));
  return checks;
}

/** Layer summary + unknown-key scan (.json only) + per-section
 *  provenance — the highest-precedence layer setting each key wins. */
function configLayerChecks(
  layers: ReturnType<typeof loadConfigLayers>['layers'],
  brokenCount: number
): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  for (const hit of layers) {
    if (hit.file.endsWith('.json')) {
      const verdict = jsonKeysVerdict(hit.file, `${hit.layer} ${basename(hit.file)}`);
      if (verdict.status !== 'ok') {
        checks.push(verdict);
      }
    }
  }
  checks.push(
    check(
      'config',
      'ok',
      layers.map(l => `${l.layer} ${basename(l.file)}`).join(' + ') +
        (brokenCount > 0 ? ' — broken file present' : '')
    )
  );
  const provenance = new Map<string, string>();
  for (const hit of layers) {
    for (const key of Object.keys(hit.raw)) {
      provenance.set(key, hit.layer);
    }
  }
  if (provenance.size > 0) {
    checks.push(
      check(
        'config',
        'ok',
        `sections: ${[...provenance.entries()].map(kv => kv.join('←')).join(' · ')}`
      )
    );
  }
  return checks;
}

/** Operator config in the committed file leaks the user's subscription to
 *  every clone; policy in the global file silently applies to every
 *  project this user touches. Advisory — never a fail. */
function configOwnershipChecks(
  layers: ReturnType<typeof loadConfigLayers>['layers']
): DoctorCheck[] {
  const keys = (layer: string): string[] =>
    layers.filter(l => l.layer === layer).flatMap(l => Object.keys(l.raw));
  const checks: DoctorCheck[] = [];
  const committedOps = keys('project').filter(k => CONFIG_SECTION_LAYERS[k] === 'operator');
  if (committedOps.length > 0) {
    checks.push(
      check(
        'config',
        'warn',
        `operator sections in committed config: ${committedOps.join(', ')}`,
        'move them to bro.config.local.json or ~/.config/bro/config.json'
      )
    );
  }
  const globalPolicy = keys('global').filter(k => CONFIG_SECTION_LAYERS[k] === 'policy');
  if (globalPolicy.length > 0) {
    checks.push(
      check(
        'config',
        'warn',
        `policy sections in global config: ${globalPolicy.join(', ')}`,
        "global policy applies to every project — move to the repo's bro.config.json"
      )
    );
  }
  return checks;
}

/** Schema-validation rows (spec: bro-d9dmx) — one row per layer FILE
 *  carrying violations, naming the layer + path + rule. Values that
 *  failed schema look absent downstream (defaults substitute), so the
 *  default verdict is warn; `--strict` promotes to fail. */
function configSchemaChecks(dir: string, strict: boolean): DoctorCheck[] {
  const diags = broConfigDiagnostics(dir);
  if (diags.length === 0) {
    return [check('config-schema', 'ok', 'all layers validate')];
  }
  const byFile = new Map<string, ConfigDiagnostic[]>();
  for (const d of diags) {
    const list = byFile.get(d.file) ?? [];
    list.push(d);
    byFile.set(d.file, list);
  }
  return [...byFile.values()].map(ds => {
    const first = ds[0] as ConfigDiagnostic;
    return check(
      'config-schema',
      strict ? 'fail' : 'warn',
      `${first.layer} ${basename(first.file)} — ` +
        ds.map(d => `${d.path}: ${d.message}`).join('; '),
      'invalid values silently read as defaults — fix the file'
    );
  });
}

/** Compat probe — verifies the contract bro calls (read-path --json
 *  shapes, subcommand/flag surface, store schema) rather than trusting a
 *  pre-1.0 version number. Drift fails when beads is an active store. */
function bdCompatCheck(beadsActive: boolean, compat: BdCompat): DoctorCheck {
  if (!compat.ok) {
    return check(
      'bd-compat',
      beadsActive ? 'fail' : 'warn',
      compat.problems.join('; '),
      'bd moved past the contract bro speaks — upgrade/downgrade beads or set "stores": ["jsonl"]'
    );
  }
  const v = compat.version ?? '?';
  if (compat.store === 'error') {
    return check(
      'bd-compat',
      'warn',
      `v${v} — read contract unproven: ${compat.storeErr ?? 'probe failed'}`
    );
  }
  return check(
    'bd-compat',
    'ok',
    compat.store === 'reachable'
      ? `v${v} contract verified`
      : `v${v} — read contract unproven (no store)`
  );
}

/** bd group: presence (fail only when beads is an active store), Dolt-era
 *  compat (`bd dolt` exists at all → the backend bro assumes), and store
 *  readability when a store is live. */
function bdChecks(
  dir: string,
  bd: BinProbe,
  beadsDir: boolean,
  beadsActive: boolean,
  compat: BdCompat
): DoctorCheck[] {
  if (!bd.found) {
    const fix = 'install beads (https://github.com/gastownhall/beads) or set "stores": ["jsonl"]';
    return [
      beadsActive
        ? check('bd', 'fail', binProblem(bd), fix)
        : check('bd', 'warn', binProblem(bd), 'beads store is off — nothing needs it'),
    ];
  }
  const out: DoctorCheck[] = [
    check('bd', 'ok', bd.version ?? 'present'),
    bdCompatCheck(beadsActive, compat),
  ];
  const dolt = bdTry(['dolt', 'remote', 'list'], 15_000, dir);
  if (dolt.code !== 0) {
    const err = dolt.err ? ` (${dolt.err})` : '';
    out.push(
      check(
        'bd-backend',
        'warn',
        '`bd dolt` failed',
        `bd predates the Dolt backend — upgrade beads${err}`
      )
    );
  } else {
    out.push(check('bd-backend', 'ok', 'dolt remotes reachable'));
  }
  if (beadsDir) {
    const list = bdTry(['list', '--json', '-n', '1'], 15_000, dir);
    out.push(
      list.code === 0
        ? check('bd-store', 'ok', 'beads store readable')
        : check(
            'bd-store',
            'fail',
            'beads store present but `bd list` failed',
            list.err || 'inspect the store or re-run `bd init`'
          )
    );
  } else if (beadsActive) {
    out.push(check('bd-store', 'ok', 'no .beads — auto-inits stealth on first use'));
  }
  return out;
}

/** The beads branch of the tasks row — mirrors the checkBeads command
 *  gate (binary + contract + store) so the serving backend never reads
 *  healthy on a store `bro next` would refuse. The bd rows carry the
 *  detail; this row only repeats the verdict + remediation. */
function beadsTasksCheck(
  bd: BinProbe,
  beadsActive: boolean,
  compat: BdCompat,
  tag: string
): DoctorCheck {
  const sev: DoctorStatus = beadsActive ? 'fail' : 'warn';
  if (!bd.found) {
    return check(
      'tasks',
      sev,
      `beads${tag} — bd ${binProblem(bd)}`,
      'install beads or pin connectors.tasks to another provider'
    );
  }
  if (!compat.ok) {
    return check(
      'tasks',
      sev,
      `beads${tag} — ${compat.problems.join('; ')}`,
      'fix the bd install or pin connectors.tasks to another provider'
    );
  }
  if (compat.store !== 'reachable') {
    const detail =
      compat.store === 'error'
        ? compat.storeErr
        : 'no store yet — `bd init` or `bro setup` creates one';
    return check(
      'tasks',
      sev,
      `beads${tag} — ${detail}`,
      'the serving task store must answer before next/loop can use it'
    );
  }
  return check('tasks', 'ok', `beads${tag}`);
}

/** Which connector serves the `tasks` facade — the backend `bro next`,
 *  `bro task`, and the stop-gate probe actually hit (spec bro-huy5o.1).
 *  A non-beads pick is healthy without bd installed: the bd rows only
 *  gate when beads is an active store. The connector's own auth probe
 *  reports the same remediation a failing command would exit on. */
function tasksBackendCheck(
  dir: string,
  pins: Record<string, string> | undefined,
  bd: BinProbe,
  beadsActive: boolean,
  compat: BdCompat
): DoctorCheck {
  const prefer = pins ?? {};
  const pinned = prefer.tasks;
  let name: string;
  try {
    name = facadeName('tasks', { dir }, { prefer });
  } catch (err) {
    return check(
      'tasks',
      'fail',
      `unresolvable — ${err instanceof Error ? err.message : String(err)}`,
      pinned !== undefined ? `connector "${pinned}" cannot serve tasks here` : undefined
    );
  }
  const tag = pinned !== undefined ? ` (connectors.tasks=${pinned})` : ' (default)';
  if (name === 'beads') {
    return beadsTasksCheck(bd, beadsActive, compat, tag);
  }
  const auth = facadeAuth('tasks', { dir }, { prefer });
  if (auth !== null) {
    return check('tasks', 'warn', `${name}${tag} — ${auth}`, 'fix it or repoint connectors.tasks');
  }
  // the claims plane's own word (spec bro-l8c4f.12): a best-effort
  // claim() is assignment, not a lease, and undeclared is unverified —
  // a competitive runner on this tracker needs an exclusive-claiming store
  let capNote = ' — claim exclusivity undeclared';
  try {
    const cap = facade('tasks', { dir }, { prefer }).claimCapability?.();
    if (cap?.strength === 'exclusive') {
      capNote = '';
    } else if (cap !== undefined) {
      capNote = ' — claims best-effort (assignment, not a lease)';
    }
  } catch {
    /* resolution already proved by facadeName above */
  }
  return check('tasks', 'ok', `${name}${tag}${capNote}`);
}

/** Remote group: the git remote `bro sync` pushes to, and the beads Dolt
 *  remote when a store is live (beads state is local-only without it). */
function remoteChecks(
  dir: string,
  root: string | null,
  syncRemote: string,
  beadsDir: boolean,
  bdFound: boolean
): DoctorCheck[] {
  if (root === null) {
    return [];
  }
  const remote = gitTry(['-C', dir, 'remote', 'get-url', syncRemote]);
  const out: DoctorCheck[] = [
    remote.code === 0
      ? check('git-remote', 'ok', `${syncRemote} → ${remote.out.trim()}`)
      : check(
          'git-remote',
          'warn',
          `no "${syncRemote}" remote`,
          'bro sync and beads replication stay local-only'
        ),
  ];
  if (!beadsDir) {
    return out;
  }
  if (!bdFound) {
    out.push(check('dolt-remote', 'skip', 'needs bd'));
    return out;
  }
  const probe: BdProbe = (a, ms) => bdTry(a, ms, dir);
  const remotes = listDoltRemotes(probe);
  if (remotes === null) {
    out.push(check('dolt-remote', 'skip', '`bd dolt remote list` failed'));
    return out;
  }
  if (remotes.length === 0) {
    out.push(
      check(
        'dolt-remote',
        'warn',
        'none configured',
        'beads state is local-only — `bd dolt remote add` inside .beads syncs it across machines'
      )
    );
    return out;
  }
  out.push(
    check('dolt-remote', 'ok', remotes.map(r => `${r.name} → ${displayUrl(r.url)}`).join(', '))
  );
  for (const r of remotes) {
    out.push(doltStoreCheck(r));
  }
  return out;
}

/** One remote's `dolt-store` row — the refs/dolt/data head verified:
 *  the manifest's table list against the tree real git fetched (spec:
 *  specs/bro-orcdv.md). A file remote pointing at a plain noms dir
 *  verifies in place; everything git-shaped probes over `doltRemoteSrc`
 *  (the bridge mirror's upstream, not its cache). */
function doltStoreCheck(r: DoltRemote): DoctorCheck {
  const target = fileTargetPath(r.url);
  if (
    target !== null &&
    isDir(target) &&
    existsSync(join(target, 'manifest')) &&
    !existsSync(join(target, 'HEAD')) &&
    !existsSync(join(target, '.git'))
  ) {
    return doltStoreRow(r.name, doltDirHealth(target));
  }
  const src = doltRemoteSrc(r);
  if (src === null) {
    return check('dolt-store', 'skip', `${r.name} — non-git remote, nothing to verify`);
  }
  return doltStoreRow(r.name, probeDoltRemote(src));
}

/** Health → row. `missing` fails — that head boots no replica (`bd
 *  bootstrap` → 'Blob not found'). `error` only warns: unreachable /
 *  unparseable is transport or format, not corruption. A healthy head
 *  reports the verified table count; a dir probe has no sha. */
function doltStoreRow(name: string, h: DoltHeadHealth & { lastGood?: string }): DoctorCheck {
  if (h.missing.length > 0) {
    const shown =
      h.missing.slice(0, 3).join(', ') +
      (h.missing.length > 3 ? `, +${h.missing.length - 3} more` : '');
    return check(
      'dolt-store',
      'fail',
      `${name}: head ${h.head === '' ? '?' : h.head.slice(0, 12)} names ${h.missing.length} missing table(s): ${shown}` +
        (h.lastGood !== undefined ? ` — last good head ${h.lastGood.slice(0, 12)}` : ''),
      'unbootstrappable store — re-push refs/dolt/data from a healthy replica' +
        (h.lastGood !== undefined ? ` or reset it to ${h.lastGood.slice(0, 12)}` : '') +
        ' (docs/restore.md)'
    );
  }
  if (h.error !== undefined) {
    return check('dolt-store', 'warn', `${name}: unverifiable — ${h.error}`);
  }
  if (h.head === '') {
    return check('dolt-store', 'ok', `${name}: nothing published yet`);
  }
  return check(
    'dolt-store',
    'ok',
    `${name}: ${h.head.slice(0, 12)} — ${h.tables} table(s) verified`
  );
}

// --- providers (specs/bro-ribc.1.md milestone 6) ----------------------
// The configured registry as doctor rows: a listing line, an auth-env
// row per entry, and a warn per consumer ref that dangles or asks a
// kind for a surface it lacks — use-time resolution errors out either
// way; doctor just says it first.

/** The listing row — entries as `name (kind, model)`; an api host
 *  shows its default pin or the served-model count. */
function providerListCheck(providers: Record<string, ProviderEntry>): DoctorCheck {
  const names = Object.keys(providers);
  if (names.length === 0) {
    return check('providers', 'ok', 'none configured');
  }
  const label = (n: string): string => {
    const e = providers[n]!;
    if (e.type === 'api') {
      const keys = Object.keys(e.models);
      const shown = e.model ?? (keys.length === 1 ? keys[0] : `${keys.length} models`);
      return `${n} (api, ${shown})`;
    }
    const model = 'model' in e && typeof e.model === 'string' ? `, ${e.model}` : '';
    return `${n} (${e.type}${model})`;
  };
  return check('providers', 'ok', `${names.length} configured: ${names.map(label).join(', ')}`);
}

/** One entry's auth env var — the NAME is config; the value is never
 *  echoed (an all-caps pasted key passes isEnvName), so messages name
 *  the config field only. */
function providerAuthCheck(name: string, entry: ProviderEntry): DoctorCheck | null {
  const keyName = 'apiKeyEnv' in entry ? entry.apiKeyEnv : undefined;
  if (keyName === undefined) {
    return null;
  }
  if (!isEnvName(keyName)) {
    return check(
      'providers',
      'warn',
      `providers.${name}.apiKeyEnv is not a valid env var name`,
      'name the variable holding the key (SCREAMING_SNAKE) — config never holds the key itself'
    );
  }
  if (process.env[keyName] === undefined || process.env[keyName] === '') {
    return check(
      'providers',
      'warn',
      `the env var named by providers.${name}.apiKeyEnv is not set`,
      'export it — the provider fails at first use without it'
    );
  }
  return check('providers', 'ok', `providers.${name} auth env set`);
}

type ProviderRef = [field: string, name: string, surface: ProviderSurface];

/** Every provider name a consumer config references — `judge.provider`
 *  (and `judge.fallback` — provider mode only: a connector-mode
 *  fallback names a connector, not this check's business),
 *  `agents.<backend>.provider`, `fleet.profiles.*.provider`. */
function providerRefs(jcfg: JudgeConfig, env: AgentConnectorEnv): ProviderRef[] {
  return [
    ...(jcfg.provider === undefined || jcfg.provider === ''
      ? []
      : ([['judge.provider', jcfg.provider, 'call']] as ProviderRef[])),
    ...(jcfg.provider === undefined || jcfg.fallback === undefined || jcfg.fallback === ''
      ? []
      : ([['judge.fallback', jcfg.fallback, 'call']] as ProviderRef[])),
    ...Object.entries(env.agents).flatMap(([b, a]): ProviderRef[] =>
      typeof a.provider === 'string' && a.provider !== ''
        ? [[`agents.${b}.provider`, a.provider, 'spawn']]
        : []
    ),
    ...Object.entries(env.fleet?.profiles ?? {}).map(
      ([p, f]): ProviderRef => [`fleet.profiles.${p}.provider`, f.provider, 'spawn']
    ),
  ];
}

/** One ref row → a warn when the name resolves to no entry, or to a
 *  kind lacking the asked surface. Judge names resolve against the
 *  effective registry — the user's entries plus the synthesized legacy
 *  aliases ('systemone' always, 'llm-judge' when judge.llm is set). */
function providerRefCheck(
  effective: Record<string, ProviderEntry>,
  [field, name, surface]: ProviderRef
): DoctorCheck | null {
  const entry = effective[name];
  if (entry === undefined) {
    return check(
      'providers',
      'warn',
      `${field} names '${name}' — no such provider entry`,
      'add it under providers{} or fix the reference — use-time resolution errors out'
    );
  }
  const kind = PROVIDER_REGISTRY[entry.type];
  if (surface === 'call' ? kind.call === null : !kind.spawn) {
    return check(
      'providers',
      'warn',
      `${field} names '${name}' (${entry.type}) — no ${surface} surface`,
      'the kind lacks that surface — use-time resolution errors out'
    );
  }
  return null;
}

function providerChecks(dir: string): DoctorCheck[] {
  const env = loadAgentEnv(dir);
  const providers = env.providers ?? {};
  const { judge: jcfg } = judgeConfig(dir);
  const effective = synthesizedProviders(jcfg, providers);
  const present = (c: DoctorCheck | null): c is DoctorCheck => c !== null;
  return [
    providerListCheck(providers),
    ...Object.entries(providers)
      .map(([n, e]) => providerAuthCheck(n, e))
      .filter(present),
    ...providerRefs(jcfg, env)
      .map(r => providerRefCheck(effective, r))
      .filter(present),
  ];
}

// --- conductor classifier guard (bro-9ww2q) -------------------------------
// A client whose ANTHROPIC_BASE_URL lands on an acp-backed /v1 plane runs
// its permission/safety classifier through session/new — a check that must
// answer in seconds pays the full session-start cost (hooks, bd reads)
// and fails closed, deadlocking interactive approvals (retro bro-p0baz).
// The triangle is static: providers.<name> acp entry, the serve endpoint
// referencing it (BRO_PROVIDER_BACKEND), and the client's classifier
// knobs naming a wire that endpoint serves.

/** Env knobs a Claude-shaped client resolves its classifier lane through
 *  — dedicated small/fast pins first; unset, the main-model lane carries
 *  the check instead (and inherits the same endpoint). */
const CLASSIFIER_KNOBS = ['ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'] as const;
const MODEL_KNOBS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
] as const;

interface ClientSource {
  label: string;
  env: Record<string, string>;
  /** top-level `model` field — the main lane the classifier inherits. */
  model?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** One client settings file → its env block + main model, or null when
 *  the file carries no client signal. */
function readClientSource(path: string, label: string): ClientSource | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const env: Record<string, string> = {};
    if (isRecord(raw.env)) {
      for (const [k, v] of Object.entries(raw.env)) {
        if (typeof v === 'string' && v.trim() !== '') {
          env[k] = v.trim();
        }
      }
    }
    const model =
      typeof raw.model === 'string' && raw.model.trim() !== '' ? raw.model.trim() : undefined;
    return Object.keys(env).length > 0 || model !== undefined ? { label, env, model } : null;
  } catch {
    return null; // absent/malformed — not client evidence
  }
}

/** Where the client's env block can pin a classifier model: user-level
 *  claude settings (CLAUDE_CONFIG_DIR honored like the client does),
 *  the repo's .claude settings pair, and doctor's own process env (a
 *  live client session's knobs). */
function claudeClientSources(dirs: string[]): ClientSource[] {
  const home = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude');
  const files: [path: string, label: string][] = [
    [join(home, 'settings.json'), `${home}/settings.json`],
    [join(home, 'settings.local.json'), `${home}/settings.local.json`],
  ];
  for (const d of new Set(dirs)) {
    files.push(
      [join(d, '.claude', 'settings.json'), '.claude/settings.json'],
      [join(d, '.claude', 'settings.local.json'), '.claude/settings.local.json']
    );
  }
  const out: ClientSource[] = [];
  for (const [path, label] of files) {
    const src = readClientSource(path, label);
    if (src !== null) {
      out.push(src);
    }
  }
  const procEnv: Record<string, string> = {};
  for (const k of [...CLASSIFIER_KNOBS, ...MODEL_KNOBS, 'ANTHROPIC_BASE_URL']) {
    const v = process.env[k];
    if (v !== undefined && v.trim() !== '') {
      procEnv[k] = v.trim();
    }
  }
  if (Object.keys(procEnv).length > 0) {
    out.push({ label: 'process env', env: procEnv });
  }
  return out;
}

/** The knobs whose values the classifier resolves — the dedicated
 *  lane when pinned, else the main-model lane it inherits. */
function classifierPins(src: ClientSource): [knob: string, value: string][] {
  const dedicated = CLASSIFIER_KNOBS.flatMap((k): [string, string][] =>
    src.env[k] !== undefined ? [[k, src.env[k]]] : []
  );
  if (dedicated.length > 0) {
    return dedicated;
  }
  const out = MODEL_KNOBS.flatMap((k): [string, string][] =>
    src.env[k] !== undefined ? [[k, src.env[k]]] : []
  );
  if (src.model !== undefined) {
    out.push(['model', src.model]);
  }
  return out;
}

/** Loopback hostnames — same vocabulary the serve host-header guard
 *  and the debt collectors use. `bro serve` only ever binds 127.0.0.1,
 *  so a serve.json recording any other host was not written by bro —
 *  refusing it keeps a tampered state file from pointing the guard's
 *  "live endpoint" evidence at an arbitrary host. */
function loopbackUrlHost(url: string): string | undefined {
  try {
    const h = new URL(url).hostname;
    return ['localhost', '127.0.0.1', '[::1]'].includes(h) ? h : undefined;
  } catch {
    return undefined;
  }
}

/** The serve.json liveness read — same contract serve.ts publishes
 *  (readServeState + pidAlive); kept local so a state-file peek never
 *  loads the HTTP server's import graph into doctor. */
function liveServeEndpoint(dir: string): { url: string; pid: number } | undefined {
  const common = gitCommonDir(dir);
  if (common === null) {
    return undefined;
  }
  try {
    const v = JSON.parse(readFileSync(join(common, 'bro', 'serve.json'), 'utf8')) as {
      pid?: unknown;
      url?: unknown;
    };
    if (
      typeof v.pid === 'number' &&
      typeof v.url === 'string' &&
      loopbackUrlHost(v.url) !== undefined &&
      pidAlive(v.pid)
    ) {
      return { url: v.url, pid: v.pid };
    }
  } catch {
    // torn/absent state file — not a live endpoint
  }
  return undefined;
}

/** The endpoint's BRO_PROVIDER_BACKEND — doctor's own env first (when
 *  the same env hosts the serve), else the running server's /proc
 *  environ. Non-/proc platforms can't read a foreign env — the
 *  client-side wire evidence below then decides the row alone. */
function serveBackendName(serve: { url: string; pid: number } | undefined): string | undefined {
  const own = process.env.BRO_PROVIDER_BACKEND?.trim();
  if (own !== undefined && own !== '') {
    return own;
  }
  if (serve === undefined) {
    return undefined;
  }
  try {
    const environ = readFileSync(`/proc/${serve.pid}/environ`).toString('latin1');
    for (const kv of environ.split('\0')) {
      const eq = kv.indexOf('=');
      if (eq > 0 && kv.slice(0, eq) === 'BRO_PROVIDER_BACKEND') {
        const v = kv.slice(eq + 1).trim();
        return v === '' ? undefined : v;
      }
    }
  } catch {
    // unreadable — raced exit or a platform without /proc
  }
  return undefined;
}

/** The model ids an acp entry can serve: the pinned `model` field plus
 *  `--model` flags inside its command. The conductor strips any
 *  `<prefix>/` off the caller's id, so the match vocabulary is bare
 *  ids — `<name>/<id>` spellings resolve to the same wire. Two acp
 *  entries can claim the same bare id, so each id lists every entry
 *  serving it — the warn names them all rather than silently
 *  crediting whichever registered last. */
function acpWireIds(providers: Record<string, ProviderEntry>): Map<string, string[]> {
  const ids = new Map<string, string[]>();
  const add = (id: string, name: string): void => {
    if (id === '') {
      return;
    }
    const l = ids.get(id);
    if (l === undefined) {
      ids.set(id, [name]);
    } else if (!l.includes(name)) {
      l.push(name);
    }
  };
  for (const [name, e] of Object.entries(providers)) {
    if (e.type !== 'acp') {
      continue;
    }
    if (e.model !== undefined) {
      add(e.model, name);
    }
    const toks = e.command.split(/\s+/).filter(t => t !== '');
    for (let i = 0; i < toks.length; i++) {
      if (toks[i] === '--model' && i + 1 < toks.length) {
        add(toks[i + 1]!, name);
      }
      const eq = /^--model=(.+)$/.exec(toks[i]!);
      if (eq !== null) {
        add(eq[1]!, name);
      }
    }
  }
  return ids;
}

/** A client-pinned model id → the acp providers serving that wire:
 *  `<acp-name>/<id>` is conductor vocabulary outright; an
 *  unrecognized `<prefix>/<id>` or bare id matches every entry
 *  serving the bare id (the conductor strips the prefix before
 *  resolving). A prefix naming a configured *non-acp* provider is
 *  the client's own routing intent, not a conductor spelling. */
function acpWireProviders(
  value: string,
  ids: Map<string, string[]>,
  acpNames: Set<string>,
  nonAcpNames: Set<string>
): string[] {
  const slash = value.indexOf('/');
  if (slash > 0) {
    const pfx = value.slice(0, slash);
    if (acpNames.has(pfx)) {
      return [pfx];
    }
    if (nonAcpNames.has(pfx)) {
      return [];
    }
    return ids.get(value.slice(slash + 1)) ?? [];
  }
  return ids.get(value) ?? [];
}

/** Host:port identity with the loopback aliases folded — `localhost`
 *  and `[::1]` spell the serve's 127.0.0.1 bind too, and scheme/path
 *  don't change which process answers the port. Unparseable values
 *  fall back to the plain string compare. */
function endpointKey(u: string): string {
  let t = u.trim();
  while (t.endsWith('/')) {
    t = t.slice(0, -1);
  }
  for (const cand of [t, `http://${t}`]) {
    try {
      const p = new URL(cand);
      const host = ['localhost', '[::1]', '::1'].includes(p.hostname) ? '127.0.0.1' : p.hostname;
      if (host !== '') {
        return `${host}:${p.port}`;
      }
    } catch {
      // try the scheme-prefixed shape, then the plain string
    }
  }
  return t.toLowerCase();
}

/** Everything one client-source warn needs from the conductor probe —
 *  resolved once per doctor run, read-only for each source. */
interface ClassifierCtx {
  serve?: { url: string; pid: number };
  conductor?: string;
  ids: Map<string, string[]>;
  acpNames: Set<string>;
  nonAcpNames: Set<string>;
}

/** One client source → its warn row(s). A live-endpoint hit outranks
 *  bare pin hits: the classifier rides the same base url (no separate
 *  URL knob exists), so the conductor answer is the live one. */
function classifierSrcWarns(src: ClientSource, ctx: ClassifierCtx): DoctorCheck[] {
  const base = src.env['ANTHROPIC_BASE_URL'];
  const hits = classifierPins(src).flatMap(([knob, v]) => {
    const names = acpWireProviders(v, ctx.ids, ctx.acpNames, ctx.nonAcpNames)
      .map(n => 'providers.' + n)
      .join(', ');
    return names === '' ? [] : [`${knob}=${v} → ${names}`];
  });
  if (
    ctx.serve !== undefined &&
    ctx.conductor !== undefined &&
    base !== undefined &&
    endpointKey(base) === endpointKey(ctx.serve.url)
  ) {
    return [
      check(
        'conductor',
        'warn',
        `${src.label}: ANTHROPIC_BASE_URL → ${ctx.serve.url} is the acp conductor (providers.${ctx.conductor})` +
          (hits.length > 0
            ? ` — ${hits.join('; ')}`
            : ' — the client\u2019s safety classifier rides it too'),
        'every permission check pays a full session/new and fail-closes — point the classifier lane at a kind:api provider'
      ),
    ];
  }
  if (hits.length > 0) {
    return [
      check(
        'conductor',
        'warn',
        `${src.label}: ${hits.join('; ')} — a classifier model wire only an acp conductor serves`,
        'session-grade wires deadlock interactive approvals — pin the classifier lane at a kind:api provider'
      ),
    ];
  }
  return [];
}

/** The guardrail row(s): warn when the endpoint is proven acp-backed
 *  AND a client points its base url at it (the classifier rides the
 *  same endpoint — no separate URL knob exists), or when a classifier
 *  pin names a wire only an acp conductor serves. */
function conductorClassifierChecks(dir: string, root: string | null): DoctorCheck[] {
  const providers = loadAgentEnv(dir).providers ?? {};
  const acpNames = new Set(
    Object.entries(providers)
      .filter((kv): kv is [string, ProviderEntry & { type: 'acp' }] => kv[1].type === 'acp')
      .map(([n]) => n)
  );
  const nonAcpNames = new Set(Object.keys(providers).filter(n => !acpNames.has(n)));
  const serve = liveServeEndpoint(dir);
  const backend = serveBackendName(serve);
  const conductor = backend !== undefined && acpNames.has(backend) ? backend : undefined;
  const ctx: ClassifierCtx = {
    serve,
    conductor,
    ids: acpWireIds(providers),
    acpNames,
    nonAcpNames,
  };
  const sources = claudeClientSources(root !== null && root !== dir ? [dir, root] : [dir]);
  const warns = sources.flatMap(src => classifierSrcWarns(src, ctx));
  if (warns.length > 0) {
    return warns;
  }
  if (conductor !== undefined) {
    return [
      check(
        'conductor',
        'ok',
        `acp conductor live (providers.${conductor}) — no classifier pins on its wires`
      ),
    ];
  }
  return [
    check(
      'conductor',
      'ok',
      acpNames.size > 0
        ? `${acpNames.size} acp provider(s) — no classifier pins on their wires`
        : 'no acp-backed serve endpoint'
    ),
  ];
}

/** Build-stamp row (bro-fatja) — who last wrote this worktree's shared
 *  mutable outputs (dist/, node_modules/). The record itself is the
 *  attribution; the warns are a stamp behind HEAD and a resolvable
 *  foreign session's write. An unresolvable current session never
 *  guesses "not yours" — the detail still carries the attribution. */
function buildStampChecks(dir: string, root: string | null): DoctorCheck[] {
  if (root === null) {
    return [];
  }
  const stamp = readStamp(dir);
  if (stamp === null) {
    return [check('build', 'ok', 'no stamped build')];
  }
  const who = `last write by ${stamp.session} (${stamp.via}) ${stampAgo(stamp.ts, Date.now())}`;
  const head = gitTry(['-C', dir, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (stamp.head !== '' && head.code === 0 && stamp.head !== head.out.trim()) {
    return [
      check(
        'build',
        'warn',
        `${who} — behind HEAD`,
        'the recorded write predates this checkout — a stale build may have reverted newer work'
      ),
    ];
  }
  const me = stampSession(dir, process.env);
  if (me !== undefined && me !== stamp.session) {
    return [
      check(
        'build',
        'warn',
        `${who} — another session rebuilt since your write`,
        'verify your changes to the output tree still stand — rebuild or reapply your hotpatch'
      ),
    ];
  }
  return [check('build', 'ok', who)];
}

/** Janitor probe — a dry run over `<git-common>/bro/` reporting the
 *  retention debris the next `bro watch` tick would reap. Probes stay
 *  read-only: this counts, it never unlinks (bro-f6zp). */
function checkJanitor(dir: string): DoctorCheck | null {
  let r;
  try {
    r = runJanitor(dir, { dryRun: true });
  } catch {
    return check('janitor', 'ok', 'probe failed — reaping still runs on `bro watch` ticks');
  }
  if (r === null || !janitorDidWork(r)) {
    return check('janitor', 'ok', 'no retention debris');
  }
  // pending debris is routine, not a defect — the line says what the
  // next watch tick removes
  return check('janitor', 'ok', janitorLine(r));
}

/** Client-adapter install state (specs/bro-1qpk.1.md) — informational:
 *  "not installed" is a choice, never a defect; the row exists so a
 *  broken install ("I installed but hooks never fire") has a visible
 *  verdict. */
function checkClientPlugins(dir: string): DoctorCheck {
  const rows = pluginRows(dir);
  const perClient = new Map<string, string[]>();
  for (const r of rows) {
    if (r.state !== 'absent') {
      // a client with several module files (opencode's bro.ts + bro-cli.ts)
      // names the file after the scope
      const file = basename(r.path);
      const slot = file === 'bro.ts' ? r.scope : `${r.scope}(${file})`;
      perClient.set(r.client, [...(perClient.get(r.client) ?? []), `${slot}:${r.state}`]);
    }
  }
  const detail = [...perClient.entries()].map(([c, s]) => `${c}: ${s.join(',')}`).join(' · ');
  return detail === ''
    ? check('plugins', 'ok', 'no client adapters installed', '`bro plugins install <client>`')
    : check('plugins', 'ok', detail);
}

// --- query providers (specs/bro-14h8.1 milestone 6) -----------------
// A `query` plan shells out to the serving connector's CLI — report a
// missing binary only for connectors relevant HERE: remote-matched or
// config-pinned. `gh` is skipped — checkGh already owns that row.

/** connector name → binary it spawns — a vendor tool name in doctor's
 *  layer is the honest label (same as gh/bd/git rows). */
const QUERY_CLI_BIN: Record<string, string> = { gitlab: 'glab', atlassian: 'atlassian' };

function queryCliChecks(dir: string, cfgPins: Record<string, string>): DoctorCheck[] {
  const remote = gitTry(['-C', dir, 'remote', 'get-url', 'origin']);
  const url = remote.code === 0 ? remote.out.trim() : '';
  const out: DoctorCheck[] = [];
  for (const c of connectors()) {
    if (c.queries === undefined) {
      continue;
    }
    const bin = QUERY_CLI_BIN[c.name];
    if (bin === undefined) {
      continue;
    }
    const pinned = cfgPins['queries'] === c.name;
    const detected = url !== '' && c.matchRemote?.(url) === true;
    if (!pinned && !detected) {
      continue;
    }
    const p = probeBin(bin);
    if (!p.found) {
      out.push(
        check(
          `query-cli-${c.name}`,
          'warn',
          `${c.name} query plans need \`${bin}\` — ${binProblem(p)}`,
          `install ${bin} or drop the ${c.name} pin — query steps against it fail at run time`
        )
      );
    }
  }
  return out;
}

/** Mesh group (specs/mesh): runs only when mesh is configured — an
 *  unconfigured repo has nothing to check. Rig addressability, peer
 *  binding sanity, and `dolt` for beads-remote replicas. */
function meshRigCheck(dir: string, pinned: string | undefined): DoctorCheck {
  const origin = gitTry(['-C', dir, 'remote', 'get-url', 'origin']);
  const derived = origin.code === 0 ? rigFromRemoteUrl(origin.out.trim()) : null;
  const rig = pinned ?? (derived === null ? null : formatRigUri(derived));
  return rig !== null && rig !== undefined
    ? check('mesh', 'ok', `rig ${rig}${pinned !== undefined ? ' (pinned)' : ''}`)
    : check(
        'mesh',
        'warn',
        'rig unaddressable — no mesh.rig pin, no derivable origin',
        'peers cannot address requests here — set "mesh": { "rig": "mesh://org/repo" } or a forge-url origin'
      );
}

/** Peer census — every binding must parse; beads-remote peers are
 *  counted for the dolt probe. */
function meshPeerChecks(
  aliases: string[],
  peers: Record<string, { rig: string; remote: string }>
): { row: DoctorCheck; remotes: number } {
  let remotes = 0;
  let bad = 0;
  for (const alias of aliases) {
    const p = parsePeer(alias, peers[alias]);
    if (p === null) {
      bad++;
      continue;
    }
    if (p.transport === 'beads-remote') {
      remotes++;
    }
  }
  const row =
    bad === 0
      ? check('mesh-peers', 'ok', `${aliases.length} peer(s), ${remotes} beads-remote`)
      : check(
          'mesh-peers',
          'warn',
          `${bad}/${aliases.length} peer binding(s) unparseable`,
          'each needs {"rig": "mesh://org/repo", "remote": "…"}'
        );
  return { row, remotes };
}

/** `dolt` availability — required only when beads-remote peers exist;
 *  its absence is a warn (replicas degrade to unreachable), not a fail. */
function meshDoltCheck(): DoctorCheck {
  const dolt = probeBin('dolt');
  return dolt.found
    ? check('mesh-dolt', 'ok', dolt.version ?? 'present')
    : check(
        'mesh-dolt',
        'warn',
        'beads-remote peers configured but `dolt` not found',
        'replica sync runs `dolt clone|pull` — install dolt or rebind to a local checkout'
      );
}

/** Debt-source prerequisites (specs: bro-huy5o.4, bro-huy5o.5) — a
 *  configured source whose setup is incomplete reports here instead of
 *  being a surprise `skipped` line at collect. Unconfigured sources emit
 *  no row. */
function debtSourceChecks(
  dir: string,
  debt: { sources: string[]; sourceConfig: Record<string, Record<string, unknown>> }
): DoctorCheck[] {
  return [...debtSonarcloudCheck(dir, debt), ...debtCodacyCheck(debt), ...debtCodesceneCheck(debt)];
}

/** Missing `curl` is a shared transport failure for the HTTP sources. */
function curlCheck(name: string, detail: string): DoctorCheck | null {
  const curl = probeBin('curl');
  return curl.found
    ? null
    : check(
        name,
        'warn',
        `${detail} · curl ${binProblem(curl)}`,
        'the debt-source transport needs curl on PATH'
      );
}

function debtSonarcloudCheck(
  dir: string,
  debt: { sources: string[]; sourceConfig: Record<string, Record<string, unknown>> }
): DoctorCheck[] {
  if (!debt.sources.includes('sonarcloud')) {
    return [];
  }
  const token = process.env['SONAR_TOKEN']?.trim();
  if (token === undefined || token === '') {
    return [
      check(
        'debt-sonarcloud',
        'warn',
        'sonarcloud debt source configured but SONAR_TOKEN is not set',
        'export SONAR_TOKEN — sonarcloud.io → My Account → Security → Generate Tokens'
      ),
    ];
  }
  const project = resolveSonarProject(dir, debt.sourceConfig['sonarcloud']);
  if (project === null) {
    return [
      check(
        'debt-sonarcloud',
        'warn',
        'SONAR_TOKEN set but no project key resolves',
        'set debt.sourceConfig.sonarcloud.project_key or sonar.projectKey in sonar-project.properties / .sonarcloud.properties'
      ),
    ];
  }
  const noCurl = curlCheck('debt-sonarcloud', `project ${project.projectKey}`);
  if (noCurl !== null) {
    return [noCurl];
  }
  try {
    assertSonarHostTrusted(project);
  } catch (err) {
    if (err instanceof SourceSkipped) {
      return [
        check(
          'debt-sonarcloud',
          'warn',
          `project ${project.projectKey} · ${err.message}`,
          'collect skips the source until the host is trusted'
        ),
      ];
    }
    throw err;
  }
  return [
    check(
      'debt-sonarcloud',
      'ok',
      `SONAR_TOKEN set · project ${project.projectKey} (${project.via})`
    ),
  ];
}

function debtCodacyCheck(debt: {
  sources: string[];
  sourceConfig: Record<string, Record<string, unknown>>;
}): DoctorCheck[] {
  if (!debt.sources.includes('codacy')) {
    return [];
  }
  const api = process.env['CODACY_API_TOKEN']?.trim();
  const project = process.env['CODACY_PROJECT_TOKEN']?.trim();
  let env: string | null = null;
  if (api !== undefined && api !== '') {
    env = 'CODACY_API_TOKEN';
  } else if (project !== undefined && project !== '') {
    env = 'CODACY_PROJECT_TOKEN';
  }
  if (env === null) {
    return [
      check(
        'debt-codacy',
        'warn',
        'codacy debt source configured but neither CODACY_API_TOKEN nor CODACY_PROJECT_TOKEN is set',
        'export CODACY_API_TOKEN — app.codacy.com → account → API tokens (or a repo-scoped Project API token)'
      ),
    ];
  }
  const cfg = debt.sourceConfig['codacy'];
  const host = typeof cfg?.host === 'string' && cfg.host !== '' ? cfg.host : CODACY_HOST;
  try {
    assertTokenSafeHost(host, 'codacy');
  } catch (err) {
    if (err instanceof SourceSkipped) {
      return [
        check(
          'debt-codacy',
          'warn',
          err.message,
          'collect skips the source until the host is trusted'
        ),
      ];
    }
    throw err;
  }
  const noCurl = curlCheck('debt-codacy', `${env} set`);
  if (noCurl !== null) {
    return [noCurl];
  }
  return [check('debt-codacy', 'ok', `${env} set · ${new URL(host).host}`)];
}

function debtCodesceneCheck(debt: {
  sources: string[];
  sourceConfig: Record<string, Record<string, unknown>>;
}): DoctorCheck[] {
  if (!debt.sources.includes('codescene')) {
    return [];
  }
  const token = process.env['CODESCENE_TOKEN']?.trim();
  if (token === undefined || token === '') {
    return [
      check(
        'debt-codescene',
        'warn',
        'codescene debt source configured but CODESCENE_TOKEN is not set',
        'export CODESCENE_TOKEN — codescene.io → Account → API tokens'
      ),
    ];
  }
  const project = resolveCodesceneProject(debt.sourceConfig['codescene']);
  if (project === null) {
    return [
      check(
        'debt-codescene',
        'warn',
        'CODESCENE_TOKEN set but no project id resolves',
        'set debt.sourceConfig.codescene.project_id or CODESCENE_PROJECT_ID — the number in codescene.io/projects/<id>'
      ),
    ];
  }
  try {
    assertTokenSafeHost(project.host, 'codescene');
  } catch (err) {
    if (err instanceof SourceSkipped) {
      return [
        check(
          'debt-codescene',
          'warn',
          `project ${project.projectId} · ${err.message}`,
          'collect skips the source until the host is trusted'
        ),
      ];
    }
    throw err;
  }
  const noCurl = curlCheck('debt-codescene', `project ${project.projectId}`);
  if (noCurl !== null) {
    return [noCurl];
  }
  return [
    check(
      'debt-codescene',
      'ok',
      `CODESCENE_TOKEN set · project ${project.projectId} (${project.via})`
    ),
  ];
}

function meshChecks(
  dir: string,
  mesh: { rig?: string; peers: Record<string, { rig: string; remote: string }> }
): DoctorCheck[] {
  const aliases = Object.keys(mesh.peers);
  if (mesh.rig === undefined && aliases.length === 0) {
    return [];
  }
  const { row, remotes } = meshPeerChecks(aliases, mesh.peers);
  const out = [meshRigCheck(dir, mesh.rig), row];
  if (remotes > 0) {
    out.push(meshDoltCheck());
  }
  return out;
}

export function runDoctorChecks(
  dir: string = process.cwd(),
  opts: { strict?: boolean } = {}
): DoctorCheck[] {
  const checks: DoctorCheck[] = [checkNode()];

  const git = probeBin('git');
  checks.push(
    git.found
      ? check('git', 'ok', git.version ?? 'present')
      : check('git', 'fail', binProblem(git), 'every bro command shells out to git')
  );

  const root = repoRoot(dir);
  const cfg = loadBroConfig(dir);
  checks.push(
    root === null
      ? check(
          'repo',
          'warn',
          'not inside a git worktree',
          'worktree/branch/sync commands need a repo'
        )
      : check('repo', 'ok', `worktree root ${root} · stores: ${cfg.stores.join(', ')}`)
  );
  // a store is live when .beads exists at the root OR BEADS_DIR pins one
  // (the loop harness runs worktrees against a shared store that way)
  const envDir = process.env.BEADS_DIR;
  const beadsDir =
    (root !== null && isDir(join(root, '.beads'))) ||
    (typeof envDir === 'string' && envDir !== '' && isDir(envDir));
  const bd = probeBin('bd');
  // one compat probe serves the bd row and the tasks row — the probe is
  // a spawn bundle, never run it twice per doctor pass
  const compat = probeBdCompat(dir);
  const janitor = checkJanitor(dir);
  checks.push(
    checkGh(),
    tasksBackendCheck(dir, cfg.connectors, bd, cfg.stores.includes('beads'), compat),
    ...bdChecks(dir, bd, beadsDir, cfg.stores.includes('beads'), compat),
    checkHooks(dir),
    devinWiringCheck(root),
    ...selfDistChecks(),
    ...checkConfig(dir),
    ...configSchemaChecks(dir, opts.strict === true),
    ...providerChecks(dir),
    ...conductorClassifierChecks(dir, root),
    ...queryCliChecks(dir, cfg.connectors),
    // properties files live at the checkout root — doctor must resolve
    // them there even when run from a subdirectory (collect does the same)
    ...debtSourceChecks(root ?? dir, cfg.debt),
    ...meshChecks(dir, cfg.mesh),
    checkClientPlugins(dir),
    ...buildStampChecks(dir, root),
    ...(janitor === null ? [] : [janitor]),
    ...remoteChecks(dir, root, cfg.sync.remote, beadsDir, bd.found)
  );

  return checks;
}

export function doctorExitCode(checks: DoctorCheck[]): number {
  return checks.some(c => c.status === 'fail') ? 1 : 0;
}

const ICONS: Record<DoctorStatus, string> = { ok: '✓', warn: '!', fail: '✗', skip: '-' };

/** The budget section (specs/bro-7xgk.3.md) — bro's own registry as a
 *  local proxy for the provider's hourly window: live agents, spawns in
 *  the last hour, observed resets, last failure causes. The snapshot is
 *  telemetry, not a probe — it never affects the exit code, and a broken
 *  registry degrades the section instead of crashing the run. */
function readBudget(dir: string): { snap: BudgetSnapshot | null; err?: string } {
  try {
    return { snap: budgetSnapshotFor(dir, loadAgentEnv(dir)) };
  } catch (err) {
    return { snap: null, err: err instanceof Error ? err.message : String(err) };
  }
}

/** The text report — check lines, the budget section, the summary. */
function printDoctor(checks: DoctorCheck[], budget: ReturnType<typeof readBudget>): void {
  for (const c of checks) {
    console.log(`${ICONS[c.status]} ${c.name.padEnd(10)} ${c.detail}`);
    if (c.hint) {
      console.log(`  ${' '.repeat(10)} → ${c.hint}`);
    }
  }
  console.log('\nbudget — local estimates (bro registry only, not provider quota data)');
  if (budget.snap === null) {
    console.log(`  unreadable — ${budget.err ?? 'unknown error'}`);
  } else {
    for (const l of budgetLines(budget.snap)) {
      console.log(l);
    }
  }
  const fails = checks.filter(c => c.status === 'fail').length;
  const warns = checks.filter(c => c.status === 'warn').length;
  console.log(
    fails === 0 && warns === 0
      ? '\nbro doctor: all checks pass'
      : `\nbro doctor: ${fails} failure(s), ${warns} warning(s)`
  );
}

export function runDoctorCommand(argv: string[]): void {
  if (hasHelpFlag(argv)) {
    printUsage('usage: bro doctor [--json] [--strict]', 0);
  }
  const json = argv.includes('--json');
  // --strict: schema violations are failures, not warnings — the CI gate
  const strict = argv.includes('--strict');
  const dir = process.cwd();
  const checks = runDoctorChecks(dir, { strict });
  const budget = readBudget(dir);
  if (json) {
    console.log(
      JSON.stringify({ ok: doctorExitCode(checks) === 0, checks, budget: budget.snap }, null, 2)
    );
  } else {
    printDoctor(checks, budget);
  }
  process.exit(doctorExitCode(checks));
}
