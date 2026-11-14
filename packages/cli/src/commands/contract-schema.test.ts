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
import { evaluateExitGate, fetchPrActState } from '@broject/act';
import { rigNext } from '@broject/rig';
import {
  ledgerFacade,
  localLeaseStore,
  projectId,
  recordWall,
  scrubEnv,
  testGit,
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
import { runAgentsCommand } from './agents.ts';
import { runClaimCommand } from './claim.ts';
import { buildDump, type ContractDump } from './contract.ts';
import { runDebtCommand } from './debt.ts';
import { collectFleet, runFleetLeasesCommand, runFleetWallsCommand } from './fleet.ts';
import { runFleetHostsCommand } from './fleet-hosts.ts';
import { runModeCommand } from './mode.ts';
import { runNextCommand } from './next.ts';
import { runResumeCommand } from './resume.ts';
import { rigStatus } from './rig.ts';
import { runSessionsCommand } from './sessions.ts';
import { collectRows, runSync, skillsSection } from './skills.ts';
import { collectStatus } from './status.ts';
import { runWatchdogCommand } from './watchdog.ts';
import { collectSnapshot } from './watch.ts';
import { capture, initRepo, insideAsync, installFakeBd, tmpDir, writeBeads } from './testrepo.ts';

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
    const v = ajv.compile(schema);
    if (v === undefined) {
      throw new Error(`${rel}: schema did not compile`);
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

function schemaRefs(dump: ContractDump): string[] {
  const refs: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) {
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item);
      }
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'json' && typeof value === 'string') {
        refs.push(value);
      } else {
        walk(value);
      }
    }
  };
  for (const row of Object.values(dump.commands)) {
    if (row.contract !== undefined) {
      walk(row.contract);
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

/** The captured console.log of an emit path, parsed as the single JSON
 *  document every --json verb prints. */
async function emittedDoc(fn: () => unknown): Promise<unknown> {
  const r = await capture(() => Promise.resolve().then(() => fn()));
  const text = r.out.join('\n');
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new Error(
      `emit produced no parseable JSON doc (code ${r.code}): ${text.slice(0, 300)} ` +
        `stderr: ${r.err.join(' | ').slice(0, 300)} ` +
        `${err instanceof Error ? err.message : ''}`
    );
  }
}

// --- producers — one per contract `json` ref, each the real emit path -----

const SHA = 'a'.repeat(40);

function fakeReview(): ReviewFacade {
  const meta: PrMeta = {
    state: 'OPEN',
    isDraft: false,
    url: 'https://github.com/o/r/pull/7',
    headSha: SHA,
    headRef: 'feat/x',
    baseRef: 'main',
    mergeable: 'MERGEABLE',
    mergeState: 'CLEAN',
  };
  const threads: ReviewThread[] = [
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
  const checks: CheckInfo[] = [
    { name: 'build', state: 'SUCCESS', bucket: 'pass' },
    { name: 'greptile', state: 'PENDING', bucket: 'pending' },
  ];
  return {
    prMeta: () => meta,
    reviewThreads: async () => threads,
    checks: () => checks,
    checkAnnotations: () => new Map(),
    reviewedShas: () => [SHA],
  } as unknown as ReviewFacade;
}

/** `bro act status --json` — {pr, exit_gate} assembled exactly like
 *  cmdStatus (act.ts): fetchPrActState → evaluateExitGate → one doc. */
async function emitActStatus(): Promise<unknown> {
  const state = await fetchPrActState(fakeReview(), { repo: 'o/r', pr: 7 }, {});
  const gate = evaluateExitGate(state, {});
  return JSON.parse(JSON.stringify({ pr: state, exit_gate: gate }));
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

/** `bro skills list --json` — the {command,data:{rows}} envelope over a
 *  declared-but-uninstalled local source. */
async function emitSkillsList(): Promise<unknown> {
  const root = tmpDir('bro-schema-skills-');
  const cfg = skillsSection({ install: ['local:skills/lx'] });
  const { rows } = collectRows(root, cfg);
  return JSON.parse(JSON.stringify({ command: 'skills list', data: { rows } }));
}

/** `bro skills sync --json` — the {command,data:{steps,rows,drift}}
 *  envelope; a local source links without a spawn (injected stubs make
 *  a stray spawn impossible). */
async function emitSkillsSync(): Promise<unknown> {
  const root = tmpDir('bro-schema-skills-');
  mkdirSync(join(root, 'skills', 'lx'), { recursive: true });
  writeFileSync(join(root, 'skills', 'lx', 'SKILL.md'), '# lx\n');
  const cfg = skillsSection({ install: ['local:skills/lx'] });
  const spawn = () => {
    throw new Error('spawn must not run for a local source');
  };
  const probe = () => false;
  const { steps, rows, drift, failed } = runSync(root, cfg, spawn, probe);
  assert.equal(failed, false);
  return JSON.parse(
    JSON.stringify({
      command: 'skills sync',
      data: { steps, rows, drift: drift.map(d => ({ name: d.name, kind: d.kind })) },
    })
  );
}

/** `bro watch --json` — collectSnapshot's heartbeat doc; bare-repo
 *  planes degrade (unavailable sections), the shape stands. */
async function emitWatch(): Promise<unknown> {
  const { main } = initRepo('bro-schema-watch-');
  const snap = await collectSnapshot(main);
  return JSON.parse(JSON.stringify(snap));
}

/** `bro watchdog --json` — the {ts, skill, baselines} launch brief;
 *  probes in a bare tmpdir degrade to {unavailable}. */
async function emitWatchdog(): Promise<unknown> {
  const dir = tmpDir('bro-schema-watchdog-');
  return insideAsync(dir, dir, () => emittedDoc(() => runWatchdogCommand(['--json'])));
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
