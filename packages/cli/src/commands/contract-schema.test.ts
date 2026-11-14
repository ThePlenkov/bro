/**
 * Output-vs-schema contract tests (spec bro-6ptci.2, pbfdp AC#2).
 *
 * Every `json` ref in the plugin registry contract points at a
 * schemas/cli/*.schema.json file; contract.test.ts proves the refs
 * resolve on disk. This file proves each schema matches the emitter it
 * describes: every schema'd command runs its real emit pipeline inside
 * a hermetic fixture, the emitted --json document is validated against
 * the schema, and a mutation pass proves the schema bites — a dropped
 * required field (a rename's old half) or an injected unknown field on
 * a closed-world shape (a rename's new half) must fail validation.
 *
 * Producers exercise the command's own emit/collector path — never a
 * hand-written literal — so an emitter refactor either keeps the
 * schema green or fails here, which is the contract.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
import { resolveLedger } from '@broject/act';
import { rigNext } from '@broject/rig';
import {
  ledgerFacade,
  localLeaseStore,
  projectId,
  recordWall,
  registerConnector,
  scrubEnv,
  testGit,
  unregisterConnector,
  type ClaimFacade,
  type ClaimRow,
  type CheckInfo,
  type LedgerFacade,
  type PrMeta,
  type ReviewFacade,
  type ReviewThread,
  type TaskStore,
} from '@broject/core';
import { PLUGINS, GROUP_META } from '../plugins.ts';
import { registerAgentConnector } from '../agent-connectors/core.ts';
import { runActCommand } from './act.ts';
import { runAgentsCommand } from './agents.ts';
import { runClaimCommand } from './claim.ts';
import { buildDump, type ContractDump } from './contract.ts';
import { runConvoyCommand } from './convoy.ts';
import { runDebtCommand } from './debt.ts';
import { collectFleet, runFleetLeasesCommand, runFleetWallsCommand } from './fleet.ts';
import { runFleetHostsCommand } from './fleet-hosts.ts';
import { runMeshCommand } from './mesh.ts';
import { runModeCommand } from './mode.ts';
import { runNextCommand } from './next.ts';
import { runResumeCommand } from './resume.ts';
import { rigStatus } from './rig.ts';
import { runSessionsCommand } from './sessions.ts';
import { runSkillsCommand } from './skills.ts';
import { collectStatus } from './status.ts';
import { runWaitCommand } from './wait.ts';
import { runWatchdogCommand } from './watchdog.ts';
import { tickOnce } from './watch.ts';
import {
  capture,
  initRepo,
  initTarget,
  insideAsync,
  installFakeBd,
  tmpDir,
  writeBeads,
} from './testrepo.ts';

// ambient repo/agent/store pins must not reach fixture git children
// or the code-under-test spawns — scrub once, restore after the file
after(scrubEnv());

const PKG_DIR = join(import.meta.dirname, '..', '..');

// Every emit path that reads the task store spawns `bd` — the scripted
// fake (FAKE_BD_DB pin + BEADS_DIR precedence, same fixture e2e tests
// drive) answers list/ready/show/mol from one seeded store. The fake's
// `list` ignores --type, so EVERY open row needs a db.mols entry or
// loadMolecule fails inside the fleet/watch planes.
const bdRoot = tmpDir('bro-schema-bd-');
const bdFx = installFakeBd(bdRoot);
writeBeads(
  bdFx.db,
  [
    {
      id: 'fx-mol',
      title: 'fixture molecule',
      status: 'open',
      priority: 1,
      issue_type: 'molecule',
      created_at: '2026-01-01T00:00:00Z',
    },
    {
      id: 'fx-task',
      title: 'fixture task',
      status: 'open',
      priority: 2,
      issue_type: 'task',
      created_at: '2026-01-02T00:00:00Z',
    },
  ],
  {
    mols: {
      'fx-mol': {
        root: {
          id: 'fx-mol',
          title: 'fixture molecule',
          status: 'open',
          issue_type: 'molecule',
        },
        issues: [
          {
            id: 'fx-mol.1',
            title: 'mol step one',
            status: 'open',
            issue_type: 'task',
            priority: 2,
          },
        ],
        dependencies: [],
      },
      'fx-task': {
        root: {
          id: 'fx-task',
          title: 'fixture task',
          status: 'open',
          issue_type: 'task',
        },
        issues: [],
        dependencies: [],
      },
    },
  }
);
process.env.PATH = `${bdFx.binDir}:${process.env.PATH ?? ''}`;
process.env.FAKE_BD_DB = bdFx.db;
process.env.BEADS_DIR = bdRoot;
// a fixture XDG home keeps the session ledger, mode files and the lease
// store off the host's real state
process.env.XDG_STATE_HOME = tmpDir('bro-schema-state-');
// same for the global config layer — a host bro.config's skills.install
// or connectors section must not leak into fixture loadBroConfig reads
process.env.XDG_CONFIG_HOME = tmpDir('bro-schema-config-');

// --- schema validation ---------------------------------------------------

interface SchemaDoc {
  type?: string;
  additionalProperties?: boolean;
  items?: SchemaDoc;
}

const ajv = new Ajv2020({ allErrors: true });
const compiled = new Map<string, ValidateFunction>();
const schemaDocs = new Map<string, SchemaDoc>();

function schemaFor(rel: string): { validate: ValidateFunction; schema: SchemaDoc } {
  const abs = resolve(PKG_DIR, rel);
  let schema = schemaDocs.get(rel);
  if (schema === undefined) {
    schema = JSON.parse(readFileSync(abs, 'utf8')) as SchemaDoc;
    schemaDocs.set(rel, schema);
  }
  let validate = compiled.get(rel);
  if (validate === undefined) {
    // compile() throws on a bad schema — it never returns undefined.
    // Name the schema in the failure or a broken $ref aborts the whole
    // suite behind an opaque stack.
    let v: ValidateFunction;
    try {
      v = ajv.compile(schema);
    } catch (err) {
      throw new Error(
        `${rel}: schema did not compile — ${err instanceof Error ? err.message : String(err)}`
      );
    }
    validate = v;
    compiled.set(rel, v);
  }
  return { validate, schema };
}

function errorsOf(validate: ValidateFunction, doc: unknown): ErrorObject[] {
  return validate(doc) ? [] : [...(validate.errors ?? [])];
}

function assertValid(rel: string, doc: unknown): void {
  const { validate } = schemaFor(rel);
  const errors = errorsOf(validate, doc);
  assert.deepEqual(
    errors,
    [],
    `${rel} rejected the emitted document:\n${JSON.stringify(errors, null, 2)}\n` +
      `doc: ${JSON.stringify(doc).slice(0, 400)}`
  );
}

function assertInvalid(rel: string, doc: unknown, why: string): void {
  const { validate } = schemaFor(rel);
  assert.equal(
    errorsOf(validate, doc).length > 0,
    true,
    `${rel} accepted a mutated document (${why}) — the schema cannot catch a field rename`
  );
}

// --- contract ref walk (same walk contract.test.ts proves on disk) --------

function collectEntryRefs(rec: Record<string, unknown>, refs: string[]): void {
  for (const [key, value] of Object.entries(rec)) {
    if (key === 'json' && typeof value === 'string') {
      refs.push(value);
    } else {
      collectRefs(value, refs);
    }
  }
}

function collectRefs(node: unknown, refs: string[]): void {
  if (typeof node !== 'object' || node === null) {
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      collectRefs(item, refs);
    }
    return;
  }
  collectEntryRefs(node as Record<string, unknown>, refs);
}

function schemaRefs(dump: ContractDump): string[] {
  const refs: string[] = [];
  for (const row of Object.values(dump.commands)) {
    if (row.contract !== undefined) {
      collectRefs(row.contract, refs);
    }
  }
  return refs.sort();
}

// --- fixture helpers ------------------------------------------------------

function gitRepo(): string {
  const dir = tmpDir('bro-schema-repo-');
  testGit(['init', '-b', 'main'], { cwd: dir });
  testGit(['config', 'user.email', 't@t'], { cwd: dir });
  testGit(['config', 'user.name', 't'], { cwd: dir });
  writeFileSync(join(dir, 'a.txt'), 'a');
  testGit(['add', 'a.txt'], { cwd: dir });
  testGit(['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

function ledgerFixture(): { ledger: LedgerFacade } {
  const dir = tmpDir('bro-schema-ledger-');
  const env = { BRO_HOOK_SPOOL: '0', XDG_STATE_HOME: dir } as NodeJS.ProcessEnv;
  return { ledger: ledgerFacade({ dbPath: join(dir, 'ledger.db'), env }) };
}

/** The captured console.log of an emit path, parsed as the JSON
 *  document every --json verb prints as its final stdout write.
 *  Entries scan backwards so a progress/diagnostic line emitted ahead
 *  of the document can't poison the parse, and only an object/array
 *  counts — a bare-scalar diagnostic is not the doc. */
async function emittedDoc(fn: () => unknown): Promise<unknown> {
  const prevCode = process.exitCode;
  let r: { code: number; out: string[]; err: string[] };
  try {
    r = await capture(() => Promise.resolve().then(() => fn()));
  } finally {
    // an emit's exitCode is a verdict for the shell, not for the
    // caller — a blocked gate (act status) or failed sync must not
    // leak 1 into the test process's own exit
    process.exitCode = prevCode;
  }
  for (let i = r.out.length - 1; i >= 0; i -= 1) {
    try {
      const v: unknown = JSON.parse(r.out[i]!);
      if (typeof v === 'object' && v !== null) {
        return v;
      }
    } catch {
      // not the payload entry — keep scanning backwards
    }
  }
  const text = r.out.join('\n');
  throw new Error(
    `emit produced no parseable JSON doc (code ${r.code}): ${text.slice(0, 300)} ` +
      `stderr: ${r.err.join(' | ').slice(0, 300)}`
  );
}

// --- producers — one per contract `json` ref, each the real emit path -----

const SHA = 'a'.repeat(40);

const SCHEMA_THREADS: ReviewThread[] = [
  {
    id: 't-1',
    resolved: false,
    outdated: false,
    comment: {
      author: 'bot',
      bot: true,
      path: 'x.ts',
      line: 1,
      body: 'n',
      createdAt: new Date().toISOString(),
    },
  },
];

const SCHEMA_CHECKS: CheckInfo[] = [
  { name: 'build', state: 'SUCCESS', bucket: 'pass' },
  { name: 'greptile', state: 'PENDING', bucket: 'pending' },
];

const GREEN_CHECKS: CheckInfo[] = [{ name: 'build', state: 'SUCCESS', bucket: 'pass' }];

const schemaPrMeta = (pr: number): PrMeta => ({
  state: 'OPEN',
  isDraft: false,
  url: `https://github.com/o/r/pull/${pr}`,
  headSha: SHA,
  headRef: `work/fx-${pr}`,
  baseRef: 'main',
  mergeable: 'MERGEABLE',
  mergeState: 'CLEAN',
});

/** The review host both `act status` and `watch` resolve through — a
 *  connector-registered facade so the producers exercise the commands'
 *  own resolution + gate + emit paths rather than rebuilding their
 *  output envelopes. PR 7 carries an open thread; seeded into the
 *  resolve ledger first it reads `reopened` on the watch gate row.
 *  PR 8 is the clean row (gate ok, zero threads). */
function schemaReviewFacade(): ReviewFacade {
  return {
    resolveRepo: () => 'o/r',
    prLink: (_repo: string, pr: number) => `https://github.com/o/r/pull/${pr}`,
    currentPr: () => null,
    prsForBranch: () => [],
    openPrs: () => [
      { pr: 7, headRef: 'work/fx' },
      { pr: 8, headRef: 'loop/fy' },
    ],
    parsePrRef: () => null,
    labels: () => [],
    prMeta: (t: { pr: number }) => schemaPrMeta(t.pr),
    reviewThreads: async (t: { pr: number }) => (t.pr === 7 ? SCHEMA_THREADS : []),
    // PR 8's row must reach ok:true — a pending AI reviewer blocks the
    // gate as surely as a red job, so it gets the all-green check set
    checks: (t: { pr: number }) => (t.pr === 8 ? GREEN_CHECKS : SCHEMA_CHECKS),
    checkAnnotations: () => new Map(),
    reviewedShas: () => [SHA],
    resolveThread: () => {},
    replyThread: () => {},
    mergedPrInfo: () => {
      throw new Error('unused');
    },
    mergedPrs: () => [],
  } as unknown as ReviewFacade;
}

/** Claim `dir` for the fixture review host — a matchDir connector wins
 *  auto-detection without a remote, so the real facade resolution path
 *  serves the fake (github/gitlab are remote-only matchers). */
function registerSchemaReviews(dir: string): () => void {
  registerConnector({
    name: 'schema-reviews',
    matchDir: d => d === dir,
    reviews: () => schemaReviewFacade(),
  });
  return () => unregisterConnector('schema-reviews');
}

/** `bro act status 7 --json` — the real cmdStatus emit: reviews
 *  facade → fetchPrActState → evaluateExitGate → the {pr, exit_gate}
 *  document, captured on stdout. */
async function emitActStatus(): Promise<unknown> {
  const { root, main } = initRepo('bro-schema-act-');
  const dispose = registerSchemaReviews(main);
  try {
    return await insideAsync(main, root, () =>
      emittedDoc(() => runActCommand(['status', '7', '--json']))
    );
  } finally {
    dispose();
  }
}

/** `bro agents status --json` — the board over a fixture backend
 *  (--connector pins it, so builtin backends can't degrade the doc
 *  nondeterministically). Same emit as cmdStatus. */
async function emitAgentsStatus(): Promise<unknown> {
  const agent = {
    id: 'ag-schema',
    molStep: 'fx-1',
    backend: 'schema-fixture',
    state: 'running' as const,
    pid: process.pid,
    spawnedAt: new Date().toISOString(),
  };
  const dispose = registerAgentConnector('schema-fixture', () => ({
    name: 'schema-fixture',
    spawn: () => Promise.reject(new Error('unused')),
    list: () => Promise.resolve({ agents: [agent] }),
    status: () => Promise.resolve(agent),
    stop: () => Promise.resolve(),
    capabilities: () => ({ attach: false, respawn: false, supervisor: 'none' as const }),
  }));
  const { root, main } = initRepo('bro-schema-agents-');
  try {
    return await insideAsync(main, root, () =>
      emittedDoc(() => runAgentsCommand(['status', '--json', '--connector', 'schema-fixture']))
    );
  } finally {
    dispose?.();
  }
}

/** `bro claim list --json` — {claims, warnings} over a stub facade. */
async function emitClaim(): Promise<unknown> {
  const rows: ClaimRow[] = [
    {
      resource: 'worktree:/repo/main',
      host: 'devin',
      sid: 'ses-1',
      project: 'o/r',
      exclusive: true,
      leaseUntil: null,
      claimedAt: Date.now(),
      pid: process.pid,
      pidStart: null,
      ttlMs: null,
      detail: null,
    },
  ];
  const claims: ClaimFacade = {
    claim: async () => ({ ok: true }),
    release: async () => {},
    list: async () => rows,
  };
  return emittedDoc(() =>
    runClaimCommand(['list', '--json'], {
      dir: tmpDir('bro-schema-claim-'),
      claims,
      env: {} as NodeJS.ProcessEnv,
    })
  );
}

/** A debt.jsonl ledger — two findings so stats/trend/next all emit the
 *  populated shape, not the empty degenerate. */
function debtLedger(): string {
  const dir = tmpDir('bro-schema-debt-');
  const rec = (id: string, pr: number): Record<string, unknown> => ({
    thread_id: id,
    thread_url: `https://github.com/o/r/pull/${pr}#discussion_${id}`,
    status: 'open',
    priority: 'nit',
    needs: 'code_change',
    source_pr: pr,
    source_pr_url: `https://github.com/o/r/pull/${pr}`,
    source_pr_title: `pr ${pr}`,
    merged_at: '2026-11-01T00:00:00Z',
    merged_sha: SHA,
    path: 'src/x.ts',
    line: 3,
    author: 'greptile',
    body: 'finding body',
    body_preview: 'finding body',
    fingerprint: `fp-${id}`,
    area: 'packages/cli',
    harvested_at: '2026-11-02T00:00:00Z',
    harvest_run_id: 'run-1',
    times_seen: 1,
    fix_pr: null,
    fixed_at: null,
    notes: null,
  });
  writeFileSync(
    join(dir, 'debt.jsonl'),
    `${JSON.stringify(rec('t-a', 41))}\n${JSON.stringify(rec('t-b', 42))}\n`
  );
  return dir;
}

/** `bro debt <next|stats|trend> --json` — runDebtCommand against the
 *  seeded ledger (BRO_DEBT_DIR redirects the store). */
async function emitDebt(sub: 'next' | 'stats' | 'trend'): Promise<unknown> {
  const prev = process.env.BRO_DEBT_DIR;
  process.env.BRO_DEBT_DIR = debtLedger();
  try {
    return await emittedDoc(() => runDebtCommand([sub, '--json']));
  } finally {
    if (prev === undefined) {
      delete process.env.BRO_DEBT_DIR;
    } else {
      process.env.BRO_DEBT_DIR = prev;
    }
  }
}

/** `bro fleet --json` — collectFleet's payload, the same 8-field
 *  document fleet.ts prints (rows, degraded, conflicts, prErrors,
 *  occupancy, budget, walls, wallsError). */
async function emitFleet(): Promise<unknown> {
  const { main } = initRepo('bro-schema-fleet-');
  const payload = await collectFleet(main);
  return JSON.parse(JSON.stringify(payload));
}

/** `bro fleet hosts --json` — the ledger-backed host board. */
async function emitFleetHosts(): Promise<unknown> {
  const { ledger } = ledgerFixture();
  const T0 = Date.now();
  await ledger.append([
    {
      kind: 'session',
      host: 'devin',
      sid: 's-1',
      mode: 'observe',
      state: 'live',
      lastSeen: T0,
      project: 'o/r',
    },
  ]);
  const { main } = initRepo('bro-schema-hosts-');
  return emittedDoc(() => runFleetHostsCommand(main, ['--json'], { ledger, now: T0 + 60_000 }));
}

/** `bro status --json` — collectStatus's board doc (status.ts). */
async function emitBoardStatus(): Promise<unknown> {
  const dir = gitRepo();
  return JSON.parse(JSON.stringify(collectStatus(dir)));
}

/** `bro fleet leases --json` — one live lease seeded into the fixture
 *  state home, then the command's own list emit. */
async function emitFleetLeases(): Promise<unknown> {
  const { main } = initRepo('bro-schema-leases-');
  const stateHome = process.env.XDG_STATE_HOME;
  const store = localLeaseStore(projectId(main), stateHome === undefined ? {} : { stateHome });
  const held = store.acquire(
    'contract/schema',
    { host: 'devin', pid: process.pid, rig: 'main', agentId: 'ag-1' },
    60_000
  );
  assert.equal(held.ok, true);
  return emittedDoc(() => runFleetLeasesCommand(main, ['--json'], stateHome));
}

/** `bro fleet walls --json` — one ledger wall recorded into a fixture
 *  ledger path, then the command's own list emit (source: 'ledger'). */
async function emitFleetWalls(): Promise<unknown> {
  const { main } = initRepo('bro-schema-walls-');
  const ledgerPath = join(tmpDir('bro-schema-walldb-'), 'walls.json');
  recordWall(
    {
      account: 'anthropic',
      cause: 'rate_limited',
      resetAt: new Date(Date.now() + 3_600_000).toISOString(),
      observedAt: new Date().toISOString(),
      provider: 'anthropic',
      rig: 'main',
    },
    { path: ledgerPath }
  );
  return emittedDoc(() => runFleetWallsCommand(main, ['--json'], ledgerPath));
}

/** `bro fleet resume --dry-run --json` — the re-entry report; dry-run
 *  keeps every leg read-only while still producing the full document. */
async function emitFleetResume(): Promise<unknown> {
  const { root, main } = initRepo('bro-schema-resume-');
  const agent = process.env.BRO_AGENT_ID;
  delete process.env.BRO_AGENT_ID;
  try {
    return await insideAsync(main, root, () =>
      emittedDoc(() => runResumeCommand(['--dry-run', '--json']))
    );
  } finally {
    if (agent !== undefined) {
      process.env.BRO_AGENT_ID = agent;
    }
  }
}

/** `bro mode list --json` — {modes, warnings} over an empty ledger. */
async function emitMode(): Promise<unknown> {
  const { ledger } = ledgerFixture();
  const { main } = initRepo('bro-schema-mode-');
  return emittedDoc(() =>
    runModeCommand(['list', '--json'], {
      dir: main,
      ledger,
      env: {} as NodeJS.ProcessEnv,
    })
  );
}

/** `bro next --list --json` — the ready-queue verdict over the shared
 *  fake bd (fx-1 is the claimable task; --list never mutates). */
async function emitNext(): Promise<unknown> {
  const { root, main } = initRepo('bro-schema-next-');
  return insideAsync(main, root, () => emittedDoc(() => runNextCommand(['--list', '--json'])));
}

/** `bro rig status --json` — rigStatus over a tracked fixture rig. */
async function emitRigStatus(): Promise<unknown> {
  const { root, main } = initRepo('bro-schema-rig-');
  const remote = join(root, 'remote.git');
  testGit(['init', '--bare', '-b', 'main', remote], { cwd: root });
  testGit(['remote', 'add', 'origin', remote], { cwd: main });
  testGit(['push', '-u', 'origin', 'main'], { cwd: main });
  return JSON.parse(JSON.stringify(rigStatus(main, 'test')));
}

/** `bro rig next --json` — rigNext over an injected store; an unknown
 *  item exercises the full {verdict,id,detail} blocked row. */
async function emitRigNext(): Promise<unknown> {
  const { main } = initRepo('bro-schema-rignext-');
  const store = { get: () => undefined } as unknown as TaskStore;
  return JSON.parse(JSON.stringify(rigNext(main, 'fx-1', { store })));
}

/** `bro sessions --json` — {sessions, warnings} over a seeded ledger. */
async function emitSessions(): Promise<unknown> {
  const { ledger } = ledgerFixture();
  const T0 = Date.parse('2026-11-20T12:00:00.000Z');
  await ledger.append([
    {
      kind: 'session',
      host: 'devin',
      sid: 'ses-1',
      mode: 'observe',
      state: 'live',
      lastSeen: T0,
      project: 'o/r',
    },
  ]);
  const { main } = initRepo('bro-schema-sessions-');
  return emittedDoc(() => runSessionsCommand(['--json'], { dir: main, ledger, now: T0 + 60_000 }));
}

/** A fixture root whose bro.config.json declares the skills.install
 *  the command reads — the producers run `runSkillsCommand` itself so
 *  the {command,data} envelope is the emitter's, never a literal. */
function skillsRoot(withSkill: boolean): string {
  const root = tmpDir('bro-schema-skills-');
  writeFileSync(
    join(root, 'bro.config.json'),
    `${JSON.stringify({ skills: { install: ['local:skills/lx'] } }, null, 2)}\n`
  );
  if (withSkill) {
    mkdirSync(join(root, 'skills', 'lx'), { recursive: true });
    writeFileSync(join(root, 'skills', 'lx', 'SKILL.md'), '# lx\n');
  }
  return root;
}

/** `bro skills list --json` — declared-but-uninstalled local source,
 *  real cmdList emit. */
async function emitSkillsList(): Promise<unknown> {
  const root = skillsRoot(false);
  return emittedDoc(() => runSkillsCommand(['list', '--root', root, '--json']));
}

/** `bro skills sync --json` — a local source links inside the command
 *  itself (no skills-cli spawn on that path), real cmdSync emit. */
async function emitSkillsSync(): Promise<unknown> {
  const root = skillsRoot(true);
  return emittedDoc(() => runSkillsCommand(['sync', '--root', root, '--json']));
}

/** `bro watch --json` — one real tickOnce: the janitor leg runs before
 *  the snapshot (its report rides `snap.janitor`), and a registered
 *  reviews connector turns the gates plane's `prs` into real gate
 *  rows — the seeded resolve-ledger record makes PR 7's open thread a
 *  `reopenedThreads` row, PR 8 the clean row. */
async function emitWatch(): Promise<unknown> {
  const { main } = initRepo('bro-schema-watch-');
  const dispose = registerSchemaReviews(main);
  try {
    resolveLedger(main)?.record({ repo: 'o/r', pr: 7, thread: 't-1' });
    const { snap } = await tickOnce(main);
    // fixture-quality assertions — a silent `prs: []` or missing
    // janitor would still validate, which is exactly the vacuous
    // coverage this producer exists to prevent
    assert.equal(
      snap.gates.available,
      true,
      'fixture reviews connector must serve the gates plane'
    );
    assert.ok(
      snap.gates.prs.some(g => g.ok === true),
      'gates.prs must carry the green row (PR 8)'
    );
    assert.ok(
      snap.gates.prs.some(g => (g.reopenedThreads ?? 0) > 0),
      'gates.prs must carry the reopenedThreads row (PR 7)'
    );
    assert.ok(snap.janitor !== undefined, 'tickOnce must attach the janitor leg');
    return JSON.parse(JSON.stringify(snap));
  } finally {
    dispose();
  }
}

/** `bro watchdog --json` — the {ts, skill, baselines} launch brief;
 *  probes in a bare tmpdir degrade to {unavailable}. */
async function emitWatchdog(): Promise<unknown> {
  const dir = tmpDir('bro-schema-watchdog-');
  return insideAsync(dir, dir, () => emittedDoc(() => runWatchdogCommand(['--json'])));
}

// --- deferred-read producers (spec bro-6ptci.3) ----------------------------

/** A bound-`local` mesh fixture: `main` pins mesh.rig in bro.config.json
 *  (the pin keeps selfRig off the forge-url probe — no github self-repo
 *  scan) and binds `sibling` — initTarget's github.com/acme remote names
 *  mesh://acme/sibling — whose checkout path is the peer's `local`
 *  remote. Peer-store reads route through storeFor's taskStoreAt pin, so
 *  the ambient BEADS_DIR this file sets globally never reroutes them. */
function meshCheckout(prefix: string): {
  root: string;
  main: string;
  sibling: { dir: string; db: string };
} {
  const { root, main } = initRepo(prefix);
  const sibling = initTarget(root, 'sibling');
  writeFileSync(
    join(main, 'bro.config.json'),
    `${JSON.stringify(
      {
        mesh: {
          rig: 'mesh://test/self',
          peers: { sibling: { rig: 'mesh://acme/sibling', remote: sibling.dir } },
        },
      },
      null,
      2
    )}\n`
  );
  return { root, main, sibling };
}

/** A mesh/1 envelope bead — the label-only record envelopeFromBead
 *  reconstructs (a `request` threads to itself, so its thread label
 *  must equal the bead id; lifecycle kinds carry the request id). */
function meshBead(e: {
  id: string;
  kind: 'request' | 'claim' | 'result' | 'accept' | 'reject';
  from: string;
  to: string;
  title: string;
  thread?: string;
}): Record<string, unknown> {
  const thread = e.thread ?? e.id;
  return {
    id: e.id,
    title: e.title,
    status: 'open',
    issue_type: 'task',
    labels: [
      'mesh:v:1',
      `mesh:kind:${e.kind}`,
      `mesh:thread:${thread}`,
      `mesh:from:${e.from}`,
      `mesh:to:${e.to}`,
    ],
  };
}

/** `bro convoy next <mol>` — the always-JSON emit (there is no --json
 *  flag; KNOWN_FLAGS for `next` is VALUE_FLAGS only). The shared fake-`bd`
 *  store gets a molecule exercising every ConvoyNext arm — a closed dep
 *  for inputs[], open blockers for blocked[], a dep loop for stuck[], an
 *  in_progress row and a human step for gates[]/inProgress[] — and is
 *  restored after the emit so the rest of the suite still sees the
 *  fixture it seeded. */
async function emitConvoyNext(): Promise<unknown> {
  const orig = readFileSync(bdFx.db, 'utf8');
  const db = JSON.parse(orig) as {
    rows: Array<Record<string, unknown>>;
    mols: Record<string, unknown>;
  };
  db.rows.push({
    id: 'fx-cv.a',
    title: 'step a',
    status: 'closed',
    issue_type: 'task',
    close_reason: 'gate shipped',
  });
  db.mols['fx-cv'] = {
    root: { id: 'fx-cv', title: 'convoy fixture', status: 'open', issue_type: 'molecule' },
    issues: [
      // the closed dep lives in issues AND rows — stepsOf reads the
      // mol's closed set, stepInputs reads close_reason via `bd show`
      { id: 'fx-cv.a', title: 'step a', status: 'closed', issue_type: 'task', priority: 2 },
      { id: 'fx-cv.b', title: 'step b', status: 'open', issue_type: 'task', priority: 2 },
      { id: 'fx-cv.c', title: 'step c', status: 'open', issue_type: 'task', priority: 2 },
      { id: 'fx-cv.d', title: 'step d', status: 'open', issue_type: 'task', priority: 2 },
      { id: 'fx-cv.e', title: 'step e', status: 'open', issue_type: 'task', priority: 2 },
      { id: 'fx-cv.f', title: 'step f', status: 'open', issue_type: 'task', priority: 2 },
      { id: 'fx-cv.g', title: 'step g', status: 'in_progress', issue_type: 'task', priority: 2 },
      { id: 'fx-cv.h', title: 'review gate', status: 'open', issue_type: 'human', priority: 2 },
    ],
    dependencies: [
      { issue_id: 'fx-cv.b', depends_on_id: 'fx-cv.a', type: 'blocks' },
      { issue_id: 'fx-cv.c', depends_on_id: 'fx-cv.d', type: 'blocks' },
      { issue_id: 'fx-cv.e', depends_on_id: 'fx-cv.f', type: 'blocks' },
      { issue_id: 'fx-cv.f', depends_on_id: 'fx-cv.e', type: 'blocks' },
    ],
  };
  writeFileSync(bdFx.db, JSON.stringify(db));
  try {
    const doc = (await emittedDoc(() => runConvoyCommand(['next', 'fx-cv']))) as {
      step?: { id: string };
      inputs?: unknown[];
      gates: string[];
      blocked: string[];
      stuck: string[];
      inProgress: string[];
    };
    // fixture quality — the degenerate doc (empty arms) still validates;
    // a silently wrong molecule must not pass as coverage
    assert.equal(doc.step?.id, 'fx-cv.b');
    assert.ok(Array.isArray(doc.inputs) && doc.inputs.length === 1, 'closed dep → step.inputs');
    assert.deepEqual(doc.gates, ['fx-cv.h']);
    assert.deepEqual(doc.blocked, ['fx-cv.c', 'fx-cv.e', 'fx-cv.f']);
    assert.deepEqual(doc.stuck, ['fx-cv.e', 'fx-cv.f']);
    assert.deepEqual(doc.inProgress, ['fx-cv.g']);
    return doc;
  } finally {
    writeFileSync(bdFx.db, orig);
  }
}

/** `bro wait external:<rig>:<id> --json` — a bound `local` peer whose
 *  store carries the request bead + the requester's own reject envelope:
 *  the first poll settles `actionable` (the verdict is the envelope SET,
 *  not the reduced stage), so the emitted refEntry exercises the
 *  reason/stage annotation arms. `--timeout 30` is the bound's safety
 *  net — a broken fixture fails in seconds, not the 45m default. */
async function emitWait(): Promise<unknown> {
  const { root, main, sibling } = meshCheckout('bro-schema-wait-');
  writeBeads(sibling.db, [
    meshBead({
      id: 'req-1',
      kind: 'request',
      from: 'mesh://test/self',
      to: 'mesh://acme/sibling',
      title: 'port the gate',
    }),
    meshBead({
      id: 'fx-v1',
      kind: 'reject',
      thread: 'req-1',
      from: 'mesh://test/self',
      to: 'mesh://acme/sibling',
      title: 'scope changed — re-post',
    }),
  ]);
  const ref = 'external:mesh://acme/sibling:req-1';
  return insideAsync(main, root, () =>
    emittedDoc(() => runWaitCommand([ref, '--every', '0.1', '--timeout', '30', '--json']))
  );
}

/** `bro mesh wait <thread> --json` — {thread, stage?, turn?, envelopes}
 *  over the bound local peer's store: the delivered request (self-
 *  authored — localSelf admit) + the peer's claim → stage claimed,
 *  worker's turn. */
async function emitMeshWait(): Promise<unknown> {
  const { root, main, sibling } = meshCheckout('bro-schema-mwait-');
  writeBeads(sibling.db, [
    meshBead({
      id: 'req-1',
      kind: 'request',
      from: 'mesh://test/self',
      to: 'mesh://acme/sibling',
      title: 'port the gate',
    }),
    meshBead({
      id: 'fx-c1',
      kind: 'claim',
      thread: 'req-1',
      from: 'mesh://acme/sibling',
      to: 'mesh://test/self',
      title: 'claimed',
    }),
  ]);
  return insideAsync(main, root, () =>
    emittedDoc(() => runMeshCommand(['wait', 'req-1', '--json', '--no-pull']))
  );
}

/** `bro mesh inbox --json` — rows are {peer, bead, …envelope, flags?}:
 *  a clean inbound request (from = the binding rig) plus a forged one
 *  (from ≠ binding) cover the plain and `mismatch` arms. */
async function emitMeshInbox(): Promise<unknown> {
  const { root, main, sibling } = meshCheckout('bro-schema-minbox-');
  writeBeads(sibling.db, [
    meshBead({
      id: 'req-ok',
      kind: 'request',
      from: 'mesh://acme/sibling',
      to: 'mesh://test/self',
      title: 'inbound ask',
    }),
    meshBead({
      id: 'req-bad',
      kind: 'request',
      from: 'mesh://mallory/forge',
      to: 'mesh://test/self',
      title: 'forged ask',
    }),
  ]);
  return insideAsync(main, root, () =>
    emittedDoc(() => runMeshCommand(['inbox', '--json', '--no-pull']))
  );
}

// --- the producer table: contract ref → real emit -------------------------

interface Producer {
  /** removes ONE schema-required field in place — the rename's old half */
  breakRequired: (doc: unknown) => void;
  emit: () => Promise<unknown>;
}

const dropKey =
  (key: string) =>
  (doc: unknown): void => {
    delete (doc as Record<string, unknown>)[key];
  };

const dropItemKey =
  (key: string) =>
  (doc: unknown): void => {
    const rows = doc as Record<string, unknown>[];
    if (rows.length > 0) {
      delete rows[0]![key];
    } else {
      // an empty array can't lose a field — insert a shapeless row; the
      // items schema's required list must reject it either way
      rows.push({});
    }
  };

const PRODUCERS: Record<string, Producer> = {
  'schemas/cli/act-status.schema.json': {
    emit: emitActStatus,
    breakRequired: dropKey('exit_gate'),
  },
  'schemas/cli/agents-status.schema.json': {
    emit: emitAgentsStatus,
    breakRequired: dropKey('backends'),
  },
  'schemas/cli/claim.schema.json': {
    emit: emitClaim,
    breakRequired: dropKey('claims'),
  },
  'schemas/cli/convoy-next.schema.json': {
    emit: emitConvoyNext,
    breakRequired: dropKey('mol'),
  },
  'schemas/cli/debt-next.schema.json': {
    emit: () => emitDebt('next'),
    breakRequired: dropKey('thread_id'),
  },
  'schemas/cli/debt-stats.schema.json': {
    emit: () => emitDebt('stats'),
    breakRequired: dropItemKey('key'),
  },
  'schemas/cli/debt-trend.schema.json': {
    emit: () => emitDebt('trend'),
    breakRequired: dropItemKey('bucket'),
  },
  'schemas/cli/fleet.schema.json': {
    emit: emitFleet,
    breakRequired: dropKey('budget'),
  },
  'schemas/cli/fleet-hosts.schema.json': {
    emit: emitFleetHosts,
    breakRequired: dropKey('hosts'),
  },
  'schemas/cli/fleet-leases.schema.json': {
    emit: emitFleetLeases,
    breakRequired: dropItemKey('key'),
  },
  'schemas/cli/fleet-resume.schema.json': {
    emit: emitFleetResume,
    breakRequired: dropKey('sessions'),
  },
  'schemas/cli/fleet-status.schema.json': {
    emit: emitBoardStatus,
    breakRequired: dropKey('beads'),
  },
  'schemas/cli/fleet-walls.schema.json': {
    emit: emitFleetWalls,
    breakRequired: dropItemKey('account'),
  },
  'schemas/cli/mesh-inbox.schema.json': {
    emit: emitMeshInbox,
    breakRequired: dropItemKey('peer'),
  },
  'schemas/cli/mesh-wait.schema.json': {
    emit: emitMeshWait,
    breakRequired: dropKey('envelopes'),
  },
  'schemas/cli/mode.schema.json': {
    emit: emitMode,
    breakRequired: dropKey('modes'),
  },
  'schemas/cli/next.schema.json': {
    emit: emitNext,
    breakRequired: dropKey('state'),
  },
  'schemas/cli/rig-next.schema.json': {
    emit: emitRigNext,
    breakRequired: dropKey('verdict'),
  },
  'schemas/cli/rig-status.schema.json': {
    emit: emitRigStatus,
    breakRequired: dropKey('repo'),
  },
  'schemas/cli/sessions.schema.json': {
    emit: emitSessions,
    breakRequired: dropKey('sessions'),
  },
  'schemas/cli/skills-list.schema.json': {
    emit: emitSkillsList,
    breakRequired: dropKey('command'),
  },
  'schemas/cli/skills-sync.schema.json': {
    emit: emitSkillsSync,
    breakRequired: dropKey('command'),
  },
  'schemas/cli/wait.schema.json': {
    emit: emitWait,
    breakRequired: dropKey('verdict'),
  },
  'schemas/cli/watch.schema.json': {
    emit: emitWatch,
    breakRequired: dropKey('gates'),
  },
  'schemas/cli/watchdog.schema.json': {
    emit: emitWatchdog,
    breakRequired: dropKey('baselines'),
  },
};

// --- the gate -------------------------------------------------------------

describe('--json output vs schema', () => {
  const refs = schemaRefs(buildDump(PLUGINS, GROUP_META));

  test('every contract json ref has a registered producer', () => {
    const missing = refs.filter(ref => PRODUCERS[ref] === undefined);
    assert.deepEqual(missing, [], 'a schema ref without a producer never sees output validation');
    const absent = Object.keys(PRODUCERS).filter(
      ref => !refs.includes(ref) || !existsSync(resolve(PKG_DIR, ref))
    );
    assert.deepEqual(absent, [], 'a producer must name a ref that resolves on disk');
  });

  for (const [rel, producer] of Object.entries(PRODUCERS)) {
    test(`${rel} validates the emitted document`, async () => {
      const doc = await producer.emit();
      assertValid(rel, doc);
    });
  }

  for (const [rel, producer] of Object.entries(PRODUCERS)) {
    test(`${rel} rejects a dropped required field`, async () => {
      const doc = structuredClone(await producer.emit());
      producer.breakRequired(doc);
      assertInvalid(rel, doc, 'required field removed');
    });
  }

  for (const [rel, producer] of Object.entries(PRODUCERS)) {
    const { schema } = schemaFor(rel);
    const closedLevel: 'root' | 'items' | undefined =
      schema.type === 'object' && schema.additionalProperties === false
        ? 'root'
        : schema.type === 'array' && schema.items?.additionalProperties === false
          ? 'items'
          : undefined;
    if (closedLevel === undefined) {
      continue;
    }
    test(`${rel} rejects an unknown field on its closed shape`, async () => {
      const doc = structuredClone(await producer.emit());
      const rows = doc as Record<string, unknown>[];
      const target = (closedLevel === 'root' ? doc : rows[0]) as
        | Record<string, unknown>
        | undefined;
      assert.ok(
        target !== undefined,
        `${rel}: producer emitted an empty array — no item to poison`
      );
      target.__contract_bogus__ = true;
      assertInvalid(rel, doc, 'unknown field on a closed-world shape');
    });
  }
});
