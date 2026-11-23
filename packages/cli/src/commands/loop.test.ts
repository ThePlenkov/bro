import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import {
  agentRegistryPath,
  bdTry,
  clearSessionPlanes,
  countSessionReservations,
  type FleetProfile,
  laneBudgetDir,
  type Lease,
  type ProviderEntry,
  patchAgentRegistry,
  providerSlotsDir,
  registerSessionPlane,
  releaseSessionStart,
  type RoutingTable,
  resolveStepClass,
  sessionPlanes,
  SpawnError,
  type SpawnWorker,
} from '@broject/core';
import { commandCliNames } from '@broject/devin';
import { DEFAULT_LOOP_CONFIG, type LoopConfig } from '@broject/loop';
import type { LoopLane } from '@broject/rig';
import type { AgentConnectorEnv } from '../agent-connectors.ts';
import {
  admitLaneSessions,
  claimAuthorityNote,
  declaredClaimCapability,
  loopRefTails,
  resolveBeadsDir,
  resolveLoopLane,
  resumeSessionFor,
  skipLeasedBeads,
  syncAfterAudit,
} from './loop.ts';
import { bdStoreBlocker, git, initRepo, inside, tmpDir } from './testrepo.ts';

test('loop picker skips live bead leases held by another process', () => {
  const lease: Lease = {
    key: 'bead/leased',
    token: 'token',
    holder: { host: 'other-host', pid: 44, rig: 'other-rig' },
    acquiredAt: new Date(0).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const logs: string[] = [];
  assert.deepEqual(
    skipLeasedBeads(
      [{ id: 'leased' }, { id: 'free' }],
      key => (key === 'bead/leased' ? lease : undefined),
      line => logs.push(line),
      'local',
      10
    ),
    [{ id: 'free' }]
  );
  assert.deepEqual(logs, ['loop: skipping leased — leased by other-rig@other-host pid 44']);
});

// --- resolveLoopLane — the provider-registry vs raw-template pick -------------

const laneCfg = (over: Partial<LoopConfig> = {}): LoopConfig => ({
  ...DEFAULT_LOOP_CONFIG,
  ...over,
});

const laneEnv = (
  providers: Record<string, ProviderEntry> = {},
  profiles: Record<string, FleetProfile> = {},
  agents: Record<string, Record<string, unknown>> = {},
  routing: RoutingTable = {}
): AgentConnectorEnv => ({
  agents,
  connectors: {},
  fleet: { maxConcurrent: 3, profiles, routing },
  providers,
});

const argvOf = (w: SpawnWorker | undefined): string[] => (w?.kind === 'argv' ? w.argv : []);

describe('resolveLoopLane', () => {
  test('no provider anywhere → the raw template lane (empty pick)', async () => {
    const lane = await resolveLoopLane(laneEnv(), { agent: 'devin -p {promptFile}' }, laneCfg());
    assert.deepEqual(lane, {});
  });

  test('loop.provider config resolves a cli provider to its command template', async () => {
    const lane = await resolveLoopLane(
      laneEnv({ fakecli: { type: 'cli', command: 'fake run {promptFile}', model: 'm-1' } }),
      {},
      laneCfg({ provider: 'fakecli', agent: 'devin -p {promptFile}' })
    );
    assert.equal(lane.provider, 'fakecli');
    assert.equal(lane.model, 'm-1');
    assert.deepEqual(lane.worker, { kind: 'template', command: 'fake run {promptFile}' });
  });

  test('--agent <provider-name> engages the provider lane (acp → argv worker)', async () => {
    const lane = await resolveLoopLane(
      laneEnv({ devin: { type: 'acp', command: 'devin acp', model: 'swe-2' } }),
      { agent: 'devin' },
      laneCfg()
    );
    assert.equal(lane.provider, 'devin');
    assert.equal(lane.model, 'swe-2');
    assert.equal(lane.worker?.kind, 'argv');
    const argv = argvOf(lane.worker);
    const i = argv.indexOf('acp-worker');
    assert.ok(i > 0, `argv: ${argv.join(' ')}`);
    assert.deepEqual(argv.slice(i + 1), ['--command', 'devin acp', '--model', 'swe-2']);
    assert.equal(argv.includes('--auto-approve'), false);
    // provenance badge is the agent cli, not the driver
    assert.equal(lane.worker?.kind === 'argv' ? lane.worker.cliName : undefined, 'devin');
  });

  test('--auto-approve reaches the acp worker argv', async () => {
    const lane = await resolveLoopLane(
      laneEnv({ devin: { type: 'acp', command: 'devin acp' } }),
      { provider: 'devin', autoApprove: true },
      laneCfg()
    );
    assert.equal(argvOf(lane.worker).includes('--auto-approve'), true);
  });

  test('an api provider has no spawn surface — loud error', async () => {
    await assert.rejects(
      resolveLoopLane(
        laneEnv({
          judge: {
            type: 'api',
            baseUrl: 'http://x',
            models: { m: 'openai-compat' },
            apiKeyEnv: 'K',
          },
        }),
        { agent: 'judge' },
        laneCfg()
      ),
      err => err instanceof SpawnError && /no spawn surface/.test(err.message)
    );
  });

  test('an unknown --provider name is an input error naming the key', async () => {
    await assert.rejects(
      resolveLoopLane(laneEnv(), { provider: 'nope' }, laneCfg()),
      err => err instanceof SpawnError && /providers\.nope is not configured/.test(err.message)
    );
  });

  test('--profile fills provider and model piecewise', async () => {
    const lane = await resolveLoopLane(
      laneEnv(
        { kilo: { type: 'acp', command: 'kilo --acp' } },
        { cheap: { provider: 'kilo', model: 'jev-1.13', autoApprove: true } }
      ),
      { profile: 'cheap' },
      laneCfg()
    );
    assert.equal(lane.provider, 'kilo');
    assert.equal(lane.model, 'jev-1.13');
    const argv = argvOf(lane.worker);
    assert.equal(argv.includes('--auto-approve'), true);
    assert.equal(argv.includes('jev-1.13'), true);
  });

  test('agents.native.provider is the backend default for a bare run', async () => {
    const lane = await resolveLoopLane(
      laneEnv(
        { devin: { type: 'acp', command: 'devin acp' } },
        {},
        { native: { provider: 'devin' } }
      ),
      {},
      laneCfg({ agent: 'devin -p {promptFile}' })
    );
    assert.equal(lane.provider, 'devin');
    assert.equal(lane.worker?.kind, 'argv');
  });

  test('a template --agent beside provider flags is contradictory', async () => {
    await assert.rejects(
      resolveLoopLane(
        laneEnv({ devin: { type: 'acp', command: 'devin acp' } }),
        { agent: 'devin -p {promptFile}', provider: 'devin' },
        laneCfg()
      ),
      err => err instanceof SpawnError && /raw template/.test(err.message)
    );
  });

  test('--agent <provider> and a disagreeing --provider is a usage error', async () => {
    await assert.rejects(
      resolveLoopLane(
        laneEnv({
          a: { type: 'acp', command: 'a acp' },
          b: { type: 'acp', command: 'b acp' },
        }),
        { agent: 'a', provider: 'b' },
        laneCfg()
      ),
      err => err instanceof SpawnError && /different providers/.test(err.message)
    );
  });

  test('--model with no resolvable provider is refused, not silently dropped', async () => {
    await assert.rejects(
      resolveLoopLane(laneEnv(), { model: 'm-1' }, laneCfg({ agent: 'devin -p' })),
      err => err instanceof SpawnError && /ride the provider lane/.test(err.message)
    );
  });

  test('a configured loop.model with no provider is refused the same way', async () => {
    await assert.rejects(
      resolveLoopLane(laneEnv(), {}, laneCfg({ model: 'm-1' })),
      err => err instanceof SpawnError && /ride the provider lane/.test(err.message)
    );
  });

  test('the escape hatch: a template --agent bypasses a configured loop.provider', async () => {
    const lane = await resolveLoopLane(
      laneEnv({ devin: { type: 'acp', command: 'devin acp' } }),
      { agent: 'raw -p {promptFile}' },
      laneCfg({ provider: 'devin' })
    );
    assert.deepEqual(lane, {});
  });
});

// --- the routed lane — `route` is the bead's resolved fleet.routing class ----

const ROUTING: RoutingTable = {
  default: { chain: [{ provider: 'devin' }] },
  sweep: { chain: [{ provider: 'kilo', model: 'free-1' }] },
};

const routedEnv = (profiles: Record<string, FleetProfile> = {}): AgentConnectorEnv =>
  laneEnv(
    {
      devin: { type: 'acp', command: 'devin acp' },
      // the entry's model pin is what lets a chain's inline {provider,
      // model} pin honor — a bare command can't consume an override
      kilo: { type: 'cli', command: 'kilo run {promptFile}', model: 'free-1' },
      fancy: { type: 'cli', command: 'fancy run --model {model} {promptFile}' },
    },
    profiles,
    {},
    ROUTING
  );

describe('resolveLoopLane — fleet.routing per-bead class (bro-zmned)', () => {
  const sweepRoute = (env: AgentConnectorEnv) =>
    resolveStepClass(env.fleet!.routing!, env.providers ?? {}, { label: 'sweep' });

  test('the class chain head supplies provider + model when no flag pins one', async () => {
    const env = routedEnv();
    const lane = await resolveLoopLane(
      env,
      {},
      laneCfg({ agent: 'devin -p {promptFile}' }),
      sweepRoute(env)
    );
    assert.equal(lane.provider, 'kilo');
    assert.equal(lane.model, 'free-1');
    assert.equal(lane.class, 'sweep');
    assert.deepEqual(lane.worker, { kind: 'template', command: 'kilo run {promptFile}' });
  });

  test('an explicit provider outranks the chain head — and never inherits its model', async () => {
    const env = routedEnv();
    const lane = await resolveLoopLane(env, { provider: 'devin' }, laneCfg(), sweepRoute(env));
    assert.equal(lane.provider, 'devin');
    // free-1 belongs to kilo's chain slot — the devin pin drops it
    assert.equal(lane.model, undefined);
    // provenance still rides: the class resolved, the pin only overrode the provider
    assert.equal(lane.class, 'sweep');
    assert.equal(lane.worker?.kind, 'argv');
  });

  test('a flag-named profile outranks the route; a config-named one sits below it', async () => {
    const env = routedEnv({ fancy: { provider: 'fancy', model: 'm-9' } });
    const route = sweepRoute(env);
    const flagged = await resolveLoopLane(env, { profile: 'fancy' }, laneCfg(), route);
    assert.equal(flagged.provider, 'fancy');
    assert.equal(flagged.model, 'm-9');
    assert.equal(flagged.class, 'sweep');
    // loop.profile is a standing default — the declared table wins it
    const confd = await resolveLoopLane(env, {}, laneCfg({ profile: 'fancy' }), route);
    assert.equal(confd.provider, 'kilo');
    assert.equal(confd.model, 'free-1');
  });

  test('the routed head beats config defaults — loop.provider and agents.native.provider', async () => {
    const env = routedEnv();
    env.agents = { native: { provider: 'devin' } };
    const lane = await resolveLoopLane(
      env,
      {},
      laneCfg({ provider: 'devin', agent: 'x {promptFile}' }),
      sweepRoute(env)
    );
    assert.equal(lane.provider, 'kilo');
    assert.equal(lane.class, 'sweep');
  });

  test('a routed class matching the flag-pinned provider keeps its model pin', async () => {
    const env = routedEnv();
    // --provider kilo + class sweep → the chain head IS the pin: free-1 applies
    const lane = await resolveLoopLane(env, { provider: 'kilo' }, laneCfg(), sweepRoute(env));
    assert.equal(lane.provider, 'kilo');
    assert.equal(lane.model, 'free-1');
    assert.equal(lane.class, 'sweep');
  });

  test('a template --agent bypasses routing; --class beside it is contradictory', async () => {
    const env = routedEnv();
    await assert.rejects(
      resolveLoopLane(env, { agent: 'raw -p {promptFile}', class: 'sweep' }, laneCfg()),
      err => err instanceof SpawnError && /raw template/.test(err.message)
    );
    const lane = await resolveLoopLane(env, { agent: 'raw -p {promptFile}' }, laneCfg());
    assert.deepEqual(lane, {});
  });

  test('no route → no class provenance on the lane', async () => {
    const env = routedEnv();
    const lane = await resolveLoopLane(env, {}, laneCfg({ agent: 'x {promptFile}' }), undefined);
    assert.equal(lane.class, undefined);
    assert.equal(lane.provider, undefined);
  });
});

// --- the matrix pick — fleet.matrix enforce's verdict→lane tier (bro-v0pvd.1.1) ---

describe('resolveLoopLane — fleet.matrix pick (bro-v0pvd.1.1)', () => {
  const sweepRoute = (env: AgentConnectorEnv) =>
    resolveStepClass(env.fleet!.routing!, env.providers ?? {}, { label: 'sweep' });

  test('the pick sits above the route head and config defaults; the walk stays suppressed', async () => {
    const env = routedEnv({ sweeps: { provider: 'kilo', model: 'free-1' } });
    env.agents = { native: { provider: 'devin' } };
    const lane = await resolveLoopLane(
      env,
      {},
      laneCfg({ provider: 'devin', agent: 'x {promptFile}' }),
      sweepRoute(env),
      { lane: 'max', provider: 'fancy', model: 'm-9' }
    );
    // matrix > route head > cfgProfile > loop.provider > backend
    assert.equal(lane.provider, 'fancy');
    assert.equal(lane.model, 'm-9'); // the pick's model rides its own lane
    assert.equal(lane.matrix, 'max'); // the row name is provenance
    assert.equal(lane.class, 'sweep'); // class routing is orthogonal — still stamps
    // a pick engaged → the chain walk never arms: its candidates were
    // never capability-vetted
    assert.equal(lane.route, undefined);
  });

  test('an acp-bound pick carries model + autoApprove into the worker argv', async () => {
    const env = routedEnv();
    const lane = await resolveLoopLane(env, {}, laneCfg(), sweepRoute(env), {
      lane: 'max',
      provider: 'devin',
      model: 'swe-2',
      autoApprove: true,
    });
    assert.equal(lane.provider, 'devin');
    assert.equal(lane.model, 'swe-2');
    const argv = argvOf(lane.worker);
    assert.equal(argv.includes('--auto-approve'), true);
    assert.equal(argv.includes('swe-2'), true);
    assert.equal(lane.matrix, 'max');
  });

  test('an explicit --provider outranks the pick and never inherits its model', async () => {
    const env = routedEnv();
    const lane = await resolveLoopLane(env, { provider: 'kilo' }, laneCfg(), sweepRoute(env), {
      lane: 'max',
      provider: 'devin',
      model: 'swe-2',
    });
    assert.equal(lane.provider, 'kilo');
    // kilo IS the route head — its own pin applies; the pick's swe-2
    // belonged to devin's lane and drops with the override
    assert.equal(lane.model, 'free-1');
    assert.equal(lane.matrix, 'max'); // the verdict still stamps provenance
  });

  test('a pick suppresses the chain walk even when it lands on the route head', async () => {
    const env = routedEnv();
    const route = sweepRoute(env);
    // baseline — no pick: the head match arms the walk's candidates
    const unrouted = await resolveLoopLane(env, {}, laneCfg(), route);
    assert.notEqual(unrouted.route, undefined);
    const lane = await resolveLoopLane(env, {}, laneCfg(), route, {
      lane: 'max',
      provider: 'kilo',
    });
    assert.equal(lane.provider, 'kilo');
    assert.equal(lane.model, 'free-1'); // the head's own pin still applies
    assert.equal(lane.route, undefined); // the pick engaged — no walk
    assert.equal(lane.matrix, 'max');
  });

  test('a flag --profile outranks the pick; a config profile sits below it', async () => {
    const env = routedEnv({ fancy: { provider: 'fancy', model: 'm-9' } });
    const route = sweepRoute(env);
    const flagged = await resolveLoopLane(env, { profile: 'fancy' }, laneCfg(), route, {
      lane: 'max',
      provider: 'devin',
      model: 'swe-2',
    });
    assert.equal(flagged.provider, 'fancy');
    assert.equal(flagged.model, 'm-9');
    const confd = await resolveLoopLane(env, {}, laneCfg({ profile: 'fancy' }), route, {
      lane: 'max',
      provider: 'devin',
      model: 'swe-2',
    });
    // loop.profile is a standing default — the enforce pick is the
    // task-shape authority and outranks it
    assert.equal(confd.provider, 'devin');
    assert.equal(confd.model, 'swe-2');
    assert.equal(confd.matrix, 'max');
  });

  test('a pick with no routing table still binds the lane (enforce without fleet.routing)', async () => {
    const env = laneEnv({ devin: { type: 'acp', command: 'devin acp' } });
    const lane = await resolveLoopLane(env, {}, laneCfg(), undefined, {
      lane: 'max',
      provider: 'devin',
      model: 'swe-2',
    });
    assert.equal(lane.provider, 'devin');
    assert.equal(lane.model, 'swe-2');
    assert.equal(lane.matrix, 'max');
    assert.equal(lane.class, undefined);
    assert.equal(lane.route, undefined);
  });
});

describe('loopRefTails', () => {
  test('a clean repo reports no tails', () => {
    const { root, main } = initRepo('bro-loop-audit-');
    inside(main, root, () => {
      const { worktrees, branches } = loopRefTails(main);
      assert.deepEqual(worktrees, []);
      assert.deepEqual(branches, []);
    });
  });

  test('a loop worktree and a bare loop branch are both reported', () => {
    const { root, main } = initRepo('bro-loop-audit-');
    inside(main, root, () => {
      const linked = join(root, 'main--bro-x');
      git(['worktree', 'add', '-q', linked, '-b', 'loop/bro-x'], main);
      git(['branch', 'loop/bro-y'], main);
      git(['branch', 'work/not-a-loop'], main);
      const { worktrees, branches } = loopRefTails(main);
      assert.deepEqual(worktrees, [`${linked} [loop/bro-x]`]);
      assert.deepEqual(branches, ['loop/bro-y']);
    });
  });

  test('non-loop worktrees are not tails', () => {
    const { root, main } = initRepo('bro-loop-audit-');
    inside(main, root, () => {
      git(['worktree', 'add', '-q', join(root, 'main--w'), '-b', 'work/z'], main);
      const { worktrees, branches } = loopRefTails(main);
      assert.deepEqual(worktrees, []);
      assert.deepEqual(branches, []);
    });
  });
});

describe('resolveBeadsDir', () => {
  // bdTry inherits process.env — an ambient BEADS_DIR would redirect the
  // bd init/where calls below to an external store instead of the temp repo
  const ambientBeadsDir = process.env.BEADS_DIR;
  delete process.env.BEADS_DIR;
  after(() => {
    if (ambientBeadsDir !== undefined) process.env.BEADS_DIR = ambientBeadsDir;
  });

  test('a repo without beads resolves nothing', () => {
    const { root, main } = initRepo('bro-loop-beads-');
    inside(main, root, () => {
      assert.equal(resolveBeadsDir(main), undefined);
    });
  });

  test('an initialized repo resolves its .beads dir', t => {
    // needs-bd: the probe is a real init — a CGO-less bd passes
    // --version and dies here, so capability, not presence, gates
    const blocked = bdStoreBlocker();
    if (blocked !== undefined) {
      t.skip(blocked);
      return;
    }
    const { root, main } = initRepo('bro-loop-beads-');
    inside(main, root, () => {
      const init = bdTry(
        ['init', '--stealth', '--skip-agents', '--skip-hooks', '--quiet'],
        30_000,
        main
      );
      assert.equal(init.code, 0, init.err);
      assert.equal(resolveBeadsDir(main), join(main, '.beads'));
    });
  });
});

// --- claimAuthorityNote — the best-effort claims-plane advisory (spec bro-l8c4f.12)

describe('claimAuthorityNote', () => {
  test('an exclusive-claiming backend needs no advisory', () => {
    assert.equal(
      claimAuthorityNote('beads', {
        strength: 'exclusive',
        identity: 'actor',
        authority: 'store',
      }),
      undefined
    );
  });

  test('an undeclared capability still warns — absent is not a promise', () => {
    const note = claimAuthorityNote('custom', undefined);
    assert.ok(note !== undefined);
    assert.match(note, /'custom'/);
    assert.match(note, /unverified/);
  });

  test('a throwing capability getter reads as undeclared — the advisory never aborts', () => {
    const store = {
      claimCapability(): never {
        throw new Error('broken connector');
      },
    };
    assert.equal(declaredClaimCapability(store), undefined);
    assert.match(claimAuthorityNote('broken', declaredClaimCapability(store))!, /unverified/);
  });

  test('a best-effort viewer backend names the shared-identity caveat and the remedy', () => {
    const note = claimAuthorityNote('linear', {
      strength: 'best-effort',
      identity: 'viewer',
      authority: 'service',
    });
    assert.ok(note !== undefined);
    assert.match(note, /'linear'/);
    assert.match(note, /not a lease/);
    assert.match(note, /one credential claims as the same identity/);
    assert.match(note, /one loop on this backlog/);
    assert.match(note, /exclusive-claim store/);
  });
});

// --- syncAfterAudit — the audit's fail-open sync boundary (bro-cu3q8) ----------

describe('syncAfterAudit', () => {
  const capture = (fn: () => void): string => {
    const out: string[] = [];
    const real = console.log;
    console.log = (m?: unknown) => out.push(String(m));
    try {
      fn();
    } finally {
      console.log = real;
    }
    return out.join('\n');
  };

  test('a throwing sync degrades to a warning with the retry hint — never an exit', () => {
    const realExit = process.exit;
    // 'spawnSync timeout ETIMEDOUT' is the incident's own signature — a
    // wedged store's bd() throw must not reach main's catch
    const out = capture(() =>
      syncAfterAudit({ json: false }, () => {
        throw new Error('spawnSync timeout ETIMEDOUT');
      })
    );
    assert.equal(process.exit, realExit);
    assert.match(out, /warning: bro sync failed — spawnSync timeout ETIMEDOUT/);
    assert.match(out, /infra; the next run's audit retries/);
  });

  test('a stray process.exit inside sync converts to the same warning (bro-qjbwq)', () => {
    const realExit = process.exit;
    const out = capture(() =>
      syncAfterAudit({ json: false }, () => {
        process.exit(1);
      })
    );
    assert.equal(process.exit, realExit);
    assert.match(out, /warning: bro sync failed — bro sync called process.exit\(1\)/);
  });
});

describe("resumeSessionFor — the coder's own session rides again (bro-5qsnr)", () => {
  const argvLane = {
    provider: 'devin',
    worker: { kind: 'argv' as const, argv: ['bro', 'acp-worker'], cliName: 'devin' },
  };

  test('same provider + argv worker + recorded id resumes; every other shape stays cold', () => {
    const { root, main } = initRepo('bro-loop-resume-');
    inside(main, root, () => {
      // agentId+backend or the registry reader drops the row as torn
      patchAgentRegistry(main, 'bro-x1', {
        agentId: 'native-deadbeef',
        backend: 'native',
        spawnedAt: new Date().toISOString(),
        provider: 'devin',
        acpSessionId: 'sess-1',
        worktree: main,
      });
      assert.equal(resumeSessionFor({ root: main }, 'bro-x1', argvLane), 'sess-1');
      // a provider switch feeds a foreign agent a meaningless id — cold
      assert.equal(
        resumeSessionFor({ root: main }, 'bro-x1', { ...argvLane, provider: 'kilo' }),
        undefined
      );
      // no argv worker — a template lane has no --resume surface
      assert.equal(
        resumeSessionFor({ root: main }, 'bro-x1', {
          provider: 'devin',
          worker: { kind: 'template', command: 'devin -p {promptFile}' },
        }),
        undefined
      );
      assert.equal(resumeSessionFor({ root: main }, 'bro-x1', {}), undefined);
      // nothing recorded — a bead that never ran acp
      assert.equal(resumeSessionFor({ root: main }, 'bro-x2', argvLane), undefined);
    });
  });

  test('a corrupt agents.json is "no session" — never a throw past the claim', () => {
    const { root, main } = initRepo('bro-loop-resume-');
    inside(main, root, () => {
      const reg = agentRegistryPath(main)!;
      mkdirSync(dirname(reg), { recursive: true });
      writeFileSync(reg, '{not json');
      assert.equal(resumeSessionFor({ root: main }, 'bro-x1', argvLane), undefined);
    });
  });
});

// --- admitLaneSessions — the raw-template lane rides the provider cap ---------
//
// spec bro-x601l: `fleet.providerCaps.<provider>` is the account-wide
// OUTER gate — the registry spawn (prepareSpawn) judges it on the
// aggregate census over every plane the provider's entry command
// claims. The raw-template lane derives the SAME gate through the
// shared providerGateOf/admitProviderGateStarts pair (bro-9f78j), so a
// loop-spawned worker counts on the provider aggregate exactly like a
// registry spawn's.

describe('admitLaneSessions — the provider cap reaches the raw-template lane (bro-9f78j)', () => {
  const admitCtx = (
    root: string,
    agents: Record<string, Record<string, unknown>>,
    providers: Record<string, ProviderEntry> = {},
    providerCaps: Record<string, number> = {}
  ) => ({
    agent: 'alpha-cli alpha-run',
    env: {
      agents,
      connectors: {},
      fleet: { maxConcurrent: 0, providerCaps },
      providers,
    } as AgentConnectorEnv,
    root,
  });
  const admitSpec = (root: string) => ({ molStep: 'fx-1', prompt: 'p', repoRoot: root });
  const templateLane = (command: string, provider?: string): LoopLane => ({
    worker: { kind: 'template', command },
    ...(provider === undefined ? {} : { provider }),
  });
  const alphaPlane = (live: () => number) => ({
    kind: 'alpha',
    detectsCli: (cli: string) => cli === 'alpha-cli',
    countLive: live,
    startsSessions: (cmd: string) => (cmd.match(/alpha-run/g) ?? []).length,
  });
  const release = (admit: { reservation: string | undefined; crossKind: string[] }): void =>
    releaseSessionStart(
      [admit.reservation, ...admit.crossKind].filter((p): p is string => p !== undefined)
    );
  // planes are process-global — swap in the fixture's set, put the real
  // registry back no matter how the test lands
  const withPlanes = (
    planes: Parameters<typeof registerSessionPlane>[0][],
    fn: () => void
  ): void => {
    const prior = sessionPlanes();
    clearSessionPlanes();
    try {
      for (const plane of planes) {
        registerSessionPlane(plane);
      }
      fn();
    } finally {
      clearSessionPlanes();
      for (const p of prior) {
        registerSessionPlane(p);
      }
    }
  };
  const withAlphaPlane = (
    plane: Parameters<typeof registerSessionPlane>[0],
    fn: () => void
  ): void => withPlanes([plane], fn);

  test('a held loop claim counts on the provider aggregate — the next spawn refuses provider_cap', () => {
    const { root, main } = initRepo('bro-loop-admit-');
    const dirA = tmpDir('bro-alpha-resv-');
    withAlphaPlane(
      alphaPlane(() => 0),
      () => {
        inside(main, root, () => {
          // the provider's entry starts one alpha session; the lane runs
          // that same command — providerCaps.prov: 1 seats exactly one
          const ctx = admitCtx(
            main,
            { alpha: { reservationsDir: dirA } },
            { prov: { type: 'cli', command: 'alpha-cli alpha-run' } },
            { prov: 1 }
          );
          const first = admitLaneSessions(
            ctx,
            templateLane('alpha-cli alpha-run', 'prov'),
            admitSpec(main),
            'loop-fx-1'
          );
          try {
            // the provider pass's claim sits on alpha's census dir — the
            // SAME ledger the registry spawn's claims would land on
            assert.equal(countSessionReservations(dirA), 1);
            // the aggregate census sees the held claim: a second spawn
            // draws 1+1 over the lane cap and names provider_cap
            assert.throws(
              () =>
                admitLaneSessions(
                  ctx,
                  templateLane('alpha-cli alpha-run', 'prov'),
                  admitSpec(main),
                  'loop-fx-2'
                ),
              (err: unknown) =>
                err instanceof SpawnError &&
                err.kind === 'cap' &&
                err.capCause === 'provider_cap' &&
                /provider 'prov' lane cap reached.*provider_cap/.test(err.message)
            );
            // the refused spawn claimed nothing — the held claim is the
            // first admission's alone
            assert.equal(countSessionReservations(dirA), 1);
          } finally {
            release(first);
          }
        });
      }
    );
  });

  test('a shell-wrapped template resolves the provider lane its command launches', () => {
    // `sh -c '…'` resolved 'sh' under first-token reading — the
    // provider gate returned undefined and a providerCaps-only config
    // admitted workers past the account cap while the plane counted
    // the nested start (greptile PR #1094)
    const { root, main } = initRepo('bro-loop-admit-');
    const dirA = tmpDir('bro-alpha-resv-');
    withAlphaPlane(
      alphaPlane(() => 0),
      () => {
        inside(main, root, () => {
          const ctx = admitCtx(
            main,
            { alpha: { reservationsDir: dirA } },
            { prov: { type: 'cli', command: 'alpha-cli alpha-run' } },
            { prov: 1 }
          );
          const lane = templateLane("sh -c 'alpha-cli alpha-run'");
          const first = admitLaneSessions(ctx, lane, admitSpec(main), 'loop-fx-1');
          try {
            // the provider pass claimed one slot on alpha's census dir —
            // the nested start is what the lane's cap seats
            assert.equal(countSessionReservations(dirA), 1);
            assert.throws(
              () => admitLaneSessions(ctx, lane, admitSpec(main), 'loop-fx-2'),
              (err: unknown) =>
                err instanceof SpawnError &&
                err.kind === 'cap' &&
                err.capCause === 'provider_cap' &&
                /provider 'prov' lane cap reached.*provider_cap/.test(err.message)
            );
            // the refused spawn claimed nothing — the held claim is the
            // first admission's alone
            assert.equal(countSessionReservations(dirA), 1);
          } finally {
            release(first);
          }
        });
      }
    );
  });

  test('the per-kind cap still refuses under provider headroom', () => {
    const { root, main } = initRepo('bro-loop-admit-');
    const dirA = tmpDir('bro-alpha-resv-');
    // alpha IS the spawn's quota lane (sessionKind resolves from the
    // template cli) — the provider verdict rides the quota admit
    // instead of claiming the lane twice
    withAlphaPlane(
      alphaPlane(() => 1),
      () => {
        inside(main, root, () => {
          assert.throws(
            () =>
              admitLaneSessions(
                admitCtx(
                  main,
                  { alpha: { maxSessions: 1, reservationsDir: dirA } },
                  { prov: { type: 'cli', command: 'alpha-cli alpha-run' } },
                  { prov: 9 }
                ),
                templateLane('alpha-cli alpha-run', 'prov'),
                admitSpec(main),
                'loop-fx-1'
              ),
            (err: unknown) =>
              err instanceof SpawnError &&
              err.kind === 'cap' &&
              err.capCause === undefined &&
              /alpha session quota reached/.test(err.message)
          );
          // the refused admission held nothing
          assert.equal(countSessionReservations(dirA), 0);
        });
      }
    );
  });

  test("a provider-covered kind's extra starts still ride the provider cap", () => {
    const { root, main } = initRepo('bro-loop-admit-');
    const dirA = tmpDir('bro-alpha-resv-');
    // alpha carries no kind quota — sessionCapViews yields no row, so
    // without the provider-covered-kind pass its second start would
    // draw on the 'prov' lane unjudged
    withAlphaPlane(
      alphaPlane(() => 0),
      () => {
        inside(main, root, () => {
          // the provider's entry starts ONE alpha session; the template
          // starts TWO — the provider pass claims 1/1 (at cap), the
          // second start pushes the aggregate to 2 > 1 and is refused
          assert.throws(
            () =>
              admitLaneSessions(
                admitCtx(
                  main,
                  { alpha: { reservationsDir: dirA } },
                  { prov: { type: 'cli', command: 'alpha-cli alpha-run' } },
                  { prov: 1 }
                ),
                templateLane('alpha-cli alpha-run alpha-run', 'prov'),
                admitSpec(main),
                'loop-fx-1'
              ),
            (err: unknown) =>
              err instanceof SpawnError &&
              err.kind === 'cap' &&
              err.capCause === 'provider_cap' &&
              /provider 'prov' lane cap reached — (2\/1 live lanes|0 live \+ 2 starting > 1)/.test(
                err.message
              )
          );
          // every claim the refused admission briefly held went back
          assert.equal(countSessionReservations(dirA), 0);
        });
      }
    );
  });

  test('a spawn that fits seats on the quota lane carrying the provider verdict', () => {
    const { root, main } = initRepo('bro-loop-admit-');
    const dirA = tmpDir('bro-alpha-resv-');
    withAlphaPlane(
      alphaPlane(() => 0),
      () => {
        inside(main, root, () => {
          const admit = admitLaneSessions(
            admitCtx(
              main,
              {
                native: { provider: 'prov', sessionKind: 'alpha' },
                alpha: { maxSessions: 2, reservationsDir: dirA },
              },
              { prov: { type: 'cli', command: 'alpha-cli alpha-run' } },
              { prov: 1 }
            ),
            templateLane('alpha-cli alpha-run'),
            admitSpec(main),
            'loop-fx-1'
          );
          try {
            // one claim on alpha's ledger — the provider's own session
            // plane IS the quota lane's, so the verdict rode the quota
            // admit and nothing claimed twice
            assert.ok(admit.reservation !== undefined);
            assert.equal(admit.crossKind.length, 0);
            assert.equal(countSessionReservations(dirA), 1);
          } finally {
            release(admit);
          }
        });
      }
    );
  });

  test('a full provider lane refuses the quota admit with provider_cap', () => {
    // alpha's kind lane has headroom — only the provider verdict can
    // refuse here, so an admit that dropped providerCap/providerCensus
    // would wave the spawn through (the assert proves the pair rides
    // the quota admit, not just that one claim exists)
    const { root, main } = initRepo('bro-loop-admit-');
    const dirA = tmpDir('bro-alpha-resv-');
    withAlphaPlane(
      // live turns 1 only once a claim exists — the pre-flight census
      // reads 0 and passes; the quota admit's post-claim census is
      // what sees 1 live + 1 held > cap 1
      alphaPlane(() => (countSessionReservations(dirA) > 0 ? 1 : 0)),
      () => {
        inside(main, root, () => {
          assert.throws(
            () =>
              admitLaneSessions(
                admitCtx(
                  main,
                  {
                    native: { sessionKind: 'alpha' },
                    alpha: { maxSessions: 9, reservationsDir: dirA },
                  },
                  { prov: { type: 'cli', command: 'alpha-cli alpha-run' } },
                  { prov: 1 }
                ),
                templateLane('alpha-cli alpha-run'),
                admitSpec(main),
                'loop-fx-1'
              ),
            (err: unknown) =>
              err instanceof SpawnError &&
              err.kind === 'cap' &&
              err.capCause === 'provider_cap' &&
              /provider 'prov' lane cap reached.*provider_cap/.test(err.message)
          );
          // the refused admission held nothing
          assert.equal(countSessionReservations(dirA), 0);
        });
      }
    );
  });

  test('a raw template is not refused by the backend-default provider it never launches', () => {
    // the --agent escape deliberately bypasses agents.native.provider —
    // the lane's provider resolves from the spawned command's own cli,
    // so a full 'prov' lane (which the command never names) must not
    // park the worker
    const { root, main } = initRepo('bro-loop-admit-');
    const dirA = tmpDir('bro-alpha-resv-');
    withAlphaPlane(
      alphaPlane(() => 0),
      () => {
        inside(main, root, () => {
          // a live registry occupant on 'prov' fills the plane-less lane
          // to cap — the same stamp prepareSpawn's commit would land
          patchAgentRegistry(main, 'occ-1', {
            agentId: 'occ-1',
            backend: 'otherbackend',
            provider: 'prov',
            spawnedAt: new Date().toISOString(),
          });
          const admit = admitLaneSessions(
            admitCtx(
              main,
              {
                native: { provider: 'prov', sessionKind: 'alpha' },
                alpha: { maxSessions: 2, reservationsDir: dirA },
              },
              // prov's entry command is a DIFFERENT cli — the template's
              // 'alpha-cli' never launches it, so its cap does not gate
              { prov: { type: 'cli', command: 'other-cli other-run' } },
              { prov: 1 }
            ),
            templateLane('alpha-cli alpha-run'),
            admitSpec(main),
            'loop-fx-1'
          );
          try {
            assert.ok(admit.reservation !== undefined);
            assert.equal(countSessionReservations(dirA), 1);
          } finally {
            release(admit);
          }
        });
      }
    );
  });

  test('an argv lane reserves on the provider ENTRY command — the acp driver hides its starts (greptile PR #1094)', () => {
    // `bro acp-worker --command 'alpha-cli alpha-run'` reads zero alpha
    // starts on a positional grammar — the provider executable sits
    // inside the driver's --command argument. The gate counts the
    // provider ENTRY command's sessions instead
    const { root, main } = initRepo('bro-loop-admit-');
    const dirA = tmpDir('bro-alpha-resv-');
    withPlanes(
      [
        {
          kind: 'alpha',
          detectsCli: cli => cli === 'alpha-cli',
          countLive: () => 0,
          // command positions, like the real planes — a cli named
          // inside --command's argument is not a start
          startsSessions: cmd => commandCliNames(cmd).filter(c => c === 'alpha-cli').length,
        },
      ],
      () => {
        inside(main, root, () => {
          const ctx = admitCtx(
            main,
            { alpha: { reservationsDir: dirA } },
            { prov: { type: 'acp', command: 'alpha-cli alpha-run' } },
            { prov: 1 }
          );
          const lane: LoopLane = {
            provider: 'prov',
            worker: {
              kind: 'argv',
              argv: ['bro', 'acp-worker', '--command', 'alpha-cli alpha-run'],
              cliName: 'alpha-cli',
            },
          };
          const first = admitLaneSessions(ctx, lane, admitSpec(main), 'loop-fx-1');
          try {
            // the one session the provider command opens — claimed on
            // alpha's ledger like any other start
            assert.equal(countSessionReservations(dirA), 1);
            assert.throws(
              () => admitLaneSessions(ctx, lane, admitSpec(main), 'loop-fx-2'),
              (err: unknown) =>
                err instanceof SpawnError && err.kind === 'cap' && err.capCause === 'provider_cap'
            );
            assert.equal(countSessionReservations(dirA), 1);
          } finally {
            release(first);
          }
        });
      }
    );
  });

  test('overlapping provider entries share claims — one session, one slot (greptile PR #1094)', () => {
    // 'prov' covers alpha alone; 'prov2' covers alpha+beta — the
    // template's alpha starts match BOTH commands, so each provider
    // gate claimed them before the fix (4 alpha slots for 2 sessions).
    // A gate shares claims an earlier gate already landed on the same
    // kind — its cap still judges them through the aggregate census
    const { root, main } = initRepo('bro-loop-admit-');
    const dirA = tmpDir('bro-alpha-resv-');
    const dirB = tmpDir('bro-beta-resv-');
    const cliStarts = (cli: string) => (cmd: string) =>
      commandCliNames(cmd).filter(c => c === cli).length;
    withPlanes(
      [
        {
          kind: 'alpha',
          detectsCli: c => c === 'alpha-cli',
          countLive: () => 0,
          startsSessions: cliStarts('alpha-cli'),
        },
        {
          kind: 'beta',
          detectsCli: c => c === 'beta-cli',
          countLive: () => 0,
          startsSessions: cliStarts('beta-cli'),
        },
      ],
      () => {
        inside(main, root, () => {
          const ctx = admitCtx(
            main,
            { alpha: { reservationsDir: dirA }, beta: { reservationsDir: dirB } },
            {
              prov: { type: 'cli', command: 'alpha-cli a' },
              prov2: { type: 'cli', command: 'alpha-cli a; beta-cli b' },
            },
            { prov: 9, prov2: 9 }
          );
          const admit = admitLaneSessions(
            ctx,
            templateLane('alpha-cli a; alpha-cli a; beta-cli b'),
            admitSpec(main),
            'loop-fx-1'
          );
          try {
            // 2 alpha + 1 beta starts = 3 slots — never 4+1
            assert.equal(countSessionReservations(dirA), 2);
            assert.equal(countSessionReservations(dirB), 1);
          } finally {
            release(admit);
          }
        });
      }
    );
  });

  test('a fully shared provider lane still judges its cap on the shared claims (greptile PR #1094)', () => {
    // 'prov2' adds a cli no plane counts, so every plane it covers is
    // already claimed by 'prov' — it lands no slot of its own, but its
    // cap must still re-judge the census the shared claims sit in
    const { root, main } = initRepo('bro-loop-admit-');
    const dirA = tmpDir('bro-alpha-resv-');
    withPlanes(
      [
        {
          kind: 'alpha',
          detectsCli: c => c === 'alpha-cli',
          countLive: () => 0,
          startsSessions: cmd => commandCliNames(cmd).filter(c => c === 'alpha-cli').length,
        },
      ],
      () => {
        inside(main, root, () => {
          const ctx = admitCtx(
            main,
            { alpha: { reservationsDir: dirA } },
            {
              prov: { type: 'cli', command: 'alpha-cli a' },
              prov2: { type: 'cli', command: 'alpha-cli a; no-plane-cli b' },
            },
            { prov: 9, prov2: 1 }
          );
          const lane = templateLane('alpha-cli a; no-plane-cli b');
          const first = admitLaneSessions(ctx, lane, admitSpec(main), 'loop-fx-1');
          try {
            // prov claimed the alpha start; prov2's lane seats exactly
            // it — one claim total, not one per gate
            assert.equal(countSessionReservations(dirA), 1);
            // a second start pushes the shared census to 2 — prov2's
            // cap refuses it even though it would claim nothing itself
            assert.throws(
              () => admitLaneSessions(ctx, lane, admitSpec(main), 'loop-fx-2'),
              (err: unknown) =>
                err instanceof SpawnError &&
                err.kind === 'cap' &&
                err.capCause === 'provider_cap' &&
                /provider 'prov2' lane cap reached/.test(err.message)
            );
            assert.equal(countSessionReservations(dirA), 1);
          } finally {
            release(first);
          }
        });
      }
    );
  });

  test('the shared-claim re-check is what refuses — a session landing between preflight and claim trips prov2 (greptile PR #1094)', () => {
    // Alpha's live count mirrors the claim ledger — prov2's read-only
    // preflight sees 0 + 1 starting ≤ cap 1, but inside the locked
    // re-check prov's claim has landed: 1 live + 1 claim = 2 > 1. A
    // recheck deleted outright would wave this spawn through
    const { root, main } = initRepo('bro-loop-admit-');
    const dirA = tmpDir('bro-alpha-resv-');
    withPlanes(
      [
        {
          kind: 'alpha',
          detectsCli: c => c === 'alpha-cli',
          // a claim counts as live the moment it lands — the landed
          // session the mutex exists to see
          countLive: () => countSessionReservations(dirA),
          startsSessions: cmd => commandCliNames(cmd).filter(c => c === 'alpha-cli').length,
        },
      ],
      () => {
        inside(main, root, () => {
          const ctx = admitCtx(
            main,
            { alpha: { reservationsDir: dirA } },
            {
              prov: { type: 'cli', command: 'alpha-cli a' },
              prov2: { type: 'cli', command: 'alpha-cli a; no-plane-cli b' },
            },
            { prov: 9, prov2: 1 }
          );
          const lane = templateLane('alpha-cli a; no-plane-cli b');
          assert.throws(
            () => admitLaneSessions(ctx, lane, admitSpec(main), 'loop-fx-1'),
            (err: unknown) =>
              err instanceof SpawnError &&
              err.kind === 'cap' &&
              err.capCause === 'provider_cap' &&
              /provider 'prov2' lane cap reached/.test(err.message)
          );
          // rollback hands prov's claim back — nothing stays held
          assert.equal(countSessionReservations(dirA), 0);
        });
      }
    );
  });

  test('same-keyed runs on different repos each claim the plane-less provider ledger (greptile PR #1094)', () => {
    // `loop-<lead>` is repo-scoped — bead ids are — but the provider
    // ledger is host-shared: a second repo's admission must write its
    // OWN claim, or releasing the first drops the lane under a running
    // worker
    const { root: rootA, main: mainA } = initRepo('bro-loop-admit-a-');
    const { root: rootB, main: mainB } = initRepo('bro-loop-admit-b-');
    // the ledger lives under XDG_DATA_HOME — isolate it so the claims
    // never land in the host's real census dir
    const prevXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = tmpDir('bro-loop-xdg-');
    try {
      // no session planes registered — the provider entry's cli starts
      // nothing a plane counts, so its lane is the claim ledger alone
      withPlanes([], () => {
        inside(mainA, rootA, () => {
          const lane = templateLane('other-cli run', 'prov');
          const ctxA = admitCtx(
            mainA,
            {},
            { prov: { type: 'cli', command: 'other-cli run' } },
            { prov: 2 }
          );
          const first = admitLaneSessions(ctxA, lane, admitSpec(mainA), 'loop-same');
          try {
            assert.equal(countSessionReservations(providerSlotsDir('prov')), 1);
            inside(mainB, rootB, () => {
              const ctxB = admitCtx(
                mainB,
                {},
                { prov: { type: 'cli', command: 'other-cli run' } },
                { prov: 2 }
              );
              const second = admitLaneSessions(ctxB, lane, admitSpec(mainB), 'loop-same');
              try {
                // both holds — never one adopted claim
                assert.equal(countSessionReservations(providerSlotsDir('prov')), 2);
              } finally {
                release(second);
              }
            });
            // the second's release dropped only its own claim
            assert.equal(countSessionReservations(providerSlotsDir('prov')), 1);
          } finally {
            release(first);
          }
        });
      });
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = prevXdg;
    }
  });
});

// --- admitLaneSessions — the raw-template lane claims one slot per start ---

describe('admitLaneSessions — a multi-start command owes the lane every start (bro-l5ll8)', () => {
  const admitCtx = (root: string, agents: Record<string, Record<string, unknown>>) => ({
    agent: 'alpha-cli alpha-run',
    env: { agents, connectors: {}, fleet: { maxConcurrent: 0 }, providers: {} },
    root,
  });
  const admitSpec = (root: string) => ({ molStep: 'fx-1', prompt: 'p', repoRoot: root });
  const templateLane = (command: string): LoopLane => ({
    worker: { kind: 'template', command },
  });

  test('a multi-start template command holds one slot per start', () => {
    const { root, main } = initRepo('bro-loop-admit-');
    const dirA = tmpDir('bro-alpha-resv-');
    const prior = sessionPlanes();
    clearSessionPlanes();
    try {
      registerSessionPlane({
        kind: 'alpha',
        detectsCli: cli => cli === 'alpha-cli',
        countLive: () => 0,
        startsSessions: cmd => (cmd.match(/alpha-run/g) ?? []).length,
      });
      inside(main, root, () => {
        const admit = admitLaneSessions(
          admitCtx(main, {
            native: { sessionKind: 'alpha' },
            alpha: { maxSessions: 2, reservationsDir: dirA },
          }),
          templateLane('alpha-cli alpha-run alpha-run'),
          admitSpec(main),
          'loop-fx-1'
        );
        try {
          // cap 2 seats both starts — but only when each actually
          // claimed: one slot for two sessions reads the second free
          assert.equal(countSessionReservations(dirA), 2);
          assert.ok(admit.reservation !== undefined);
          assert.equal(admit.crossKind.length, 1);
        } finally {
          releaseSessionStart(
            [admit.reservation, ...admit.crossKind].filter((p): p is string => p !== undefined)
          );
        }
      });
    } finally {
      clearSessionPlanes();
      for (const plane of prior) registerSessionPlane(plane);
    }
  });

  test('the start the lane cannot seat refuses — and the earlier claim goes back', () => {
    const { root, main } = initRepo('bro-loop-admit-');
    const dirA = tmpDir('bro-alpha-resv-');
    const prior = sessionPlanes();
    clearSessionPlanes();
    try {
      registerSessionPlane({
        kind: 'alpha',
        detectsCli: cli => cli === 'alpha-cli',
        // live turns 1 once a claim exists — the pre-flight admits on
        // 0+2 ≤ 2, the locked census is what sees 1+2 > 2. The first
        // start's slot is already held when the second refuses: a leak
        // counts it against the budget for its whole TTL
        countLive: () => (countSessionReservations(dirA) > 0 ? 1 : 0),
        startsSessions: cmd => (cmd.match(/alpha-run/g) ?? []).length,
      });
      inside(main, root, () => {
        assert.throws(
          () =>
            admitLaneSessions(
              admitCtx(main, {
                native: { sessionKind: 'alpha' },
                alpha: { maxSessions: 2, reservationsDir: dirA },
              }),
              templateLane('alpha-cli alpha-run alpha-run'),
              admitSpec(main),
              'loop-fx-1'
            ),
          (err: unknown) =>
            err instanceof SpawnError &&
            err.kind === 'cap' &&
            /alpha session quota reached/.test(err.message)
        );
        assert.equal(countSessionReservations(dirA), 0);
      });
    } finally {
      clearSessionPlanes();
      for (const plane of prior) registerSessionPlane(plane);
    }
  });

  test('a mid-admission refusal refunds the work-budget segments its claims opened', () => {
    // alpha's admit opens a work-budget segment per claimed start; the
    // second start's census refuses — the first claim's segment must go
    // back or a spawn that never ran bills worker-minutes until the
    // next budget scan closes it (bro-znkki)
    const { root, main } = initRepo('bro-loop-admit-');
    const dirA = tmpDir('bro-alpha-resv-');
    const prior = sessionPlanes();
    clearSessionPlanes();
    // the budget ledger is host-shared — isolate it so the real state
    // dir never sees the test's segments
    const prevXdg = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = tmpDir('bro-loop-xdg-');
    try {
      registerSessionPlane({
        kind: 'alpha',
        detectsCli: cli => cli === 'alpha-cli',
        // live turns 1 once a claim exists — the post-claim census on
        // the second start is what refuses, so the first claim's
        // segment is already charged when the verdict lands
        countLive: () => (countSessionReservations(dirA) > 0 ? 1 : 0),
        startsSessions: cmd => (cmd.match(/alpha-run/g) ?? []).length,
      });
      inside(main, root, () => {
        assert.throws(
          () =>
            admitLaneSessions(
              admitCtx(main, {
                native: { sessionKind: 'alpha' },
                alpha: { maxSessions: 2, workBudgetMinutes: 30, reservationsDir: dirA },
              }),
              templateLane('alpha-cli alpha-run alpha-run'),
              admitSpec(main),
              'loop-fx-1'
            ),
          (err: unknown) =>
            err instanceof SpawnError &&
            err.kind === 'cap' &&
            /alpha session quota reached/.test(err.message)
        );
        assert.equal(countSessionReservations(dirA), 0);
        // the ledger exists — an admit really charged it — and no OPEN
        // segment survives: the refund removes them outright (the
        // registry-path test convention, agent-connectors.test.ts)
        const ledgerPath = join(laneBudgetDir(), 'alpha.json');
        assert.equal(existsSync(ledgerPath), true, 'the budget ledger was never charged');
        const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')) as {
          workers: Record<string, { segments: Array<{ e?: number }> }>;
        };
        for (const worker of Object.values(ledger.workers)) {
          assert.equal(
            worker.segments.every(seg => seg.e !== undefined),
            true,
            'an open work-budget segment survived the refused admission'
          );
        }
      });
    } finally {
      if (prevXdg === undefined) {
        delete process.env.XDG_STATE_HOME;
      } else {
        process.env.XDG_STATE_HOME = prevXdg;
      }
      clearSessionPlanes();
      for (const plane of prior) registerSessionPlane(plane);
    }
  });

  test('a live session plus two starts over the cap refuses before any claim', () => {
    const { root, main } = initRepo('bro-loop-admit-');
    const dirA = tmpDir('bro-alpha-resv-');
    const prior = sessionPlanes();
    clearSessionPlanes();
    try {
      registerSessionPlane({
        kind: 'alpha',
        detectsCli: cli => cli === 'alpha-cli',
        countLive: () => 1,
        startsSessions: cmd => (cmd.match(/alpha-run/g) ?? []).length,
      });
      inside(main, root, () => {
        // 1 live + 2 starting > cap 2 — a single-claim admit would read
        // only 1 starting and wave the second session past the cap
        assert.throws(
          () =>
            admitLaneSessions(
              admitCtx(main, {
                native: { sessionKind: 'alpha' },
                alpha: { maxSessions: 2, reservationsDir: dirA },
              }),
              templateLane('alpha-cli alpha-run alpha-run'),
              admitSpec(main),
              'loop-fx-1'
            ),
          (err: unknown) => err instanceof SpawnError && err.kind === 'cap'
        );
        assert.equal(countSessionReservations(dirA), 0);
      });
    } finally {
      clearSessionPlanes();
      for (const plane of prior) registerSessionPlane(plane);
    }
  });

  test('a single-start command still claims exactly one slot', () => {
    const { root, main } = initRepo('bro-loop-admit-');
    const dirA = tmpDir('bro-alpha-resv-');
    const prior = sessionPlanes();
    clearSessionPlanes();
    try {
      registerSessionPlane({
        kind: 'alpha',
        detectsCli: cli => cli === 'alpha-cli',
        countLive: () => 0,
        startsSessions: cmd => (cmd.match(/alpha-run/g) ?? []).length,
      });
      inside(main, root, () => {
        const admit = admitLaneSessions(
          admitCtx(main, {
            native: { sessionKind: 'alpha' },
            alpha: { maxSessions: 1, reservationsDir: dirA },
          }),
          templateLane('alpha-cli alpha-run'),
          admitSpec(main),
          'loop-fx-1'
        );
        try {
          assert.equal(countSessionReservations(dirA), 1);
          assert.ok(admit.reservation !== undefined);
          assert.equal(admit.crossKind.length, 0);
        } finally {
          releaseSessionStart(
            [admit.reservation, ...admit.crossKind].filter((p): p is string => p !== undefined)
          );
        }
      });
    } finally {
      clearSessionPlanes();
      for (const plane of prior) registerSessionPlane(plane);
    }
  });

  test("a lane armed on workers only still counts the command's starts", () => {
    const { root, main } = initRepo('bro-loop-admit-');
    const dirA = tmpDir('bro-alpha-resv-');
    const prior = sessionPlanes();
    clearSessionPlanes();
    try {
      registerSessionPlane({
        kind: 'alpha',
        detectsCli: cli => cli === 'alpha-cli',
        countLive: () => 0,
        countWorkers: () => 0,
        startsSessions: cmd => (cmd.match(/alpha-run/g) ?? []).length,
      });
      inside(main, root, () => {
        // no maxSessions row — sessionCapViews yields nothing for the
        // kind, so the claim count falls back to the plane's own
        // startsSessions: a two-session command still owes two slots
        const admit = admitLaneSessions(
          admitCtx(main, {
            native: { sessionKind: 'alpha' },
            alpha: { maxWorkers: 5, reservationsDir: dirA },
          }),
          templateLane('alpha-cli alpha-run alpha-run'),
          admitSpec(main),
          'loop-fx-1'
        );
        try {
          assert.equal(countSessionReservations(dirA), 2);
          assert.equal(admit.crossKind.length, 1);
        } finally {
          releaseSessionStart(
            [admit.reservation, ...admit.crossKind].filter((p): p is string => p !== undefined)
          );
        }
      });
    } finally {
      clearSessionPlanes();
      for (const plane of prior) registerSessionPlane(plane);
    }
  });
});
