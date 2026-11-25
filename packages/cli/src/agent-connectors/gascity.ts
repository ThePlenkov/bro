import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { assertMutableConfig } from '../config-policy.ts';
import type {
  AgentConnector,
  AgentInfo,
  AgentRegistryEntry,
  ConnectorCtx,
  SpawnSpec,
} from './types.ts';
import type { AgentConnectorEnv, AgentState, GcSession, ListResult } from './spawn-harness.ts';
import {
  AgentNotFound,
  SpawnError,
  agentEnvPins,
  agentsHome,
  commandCliName,
  envKeyDropped,
  externalGuardOf,
  findAgentEntry,
  fleetCapOf,
  gcConfigDir,
  gcEffectiveCommand,
  gcErr,
  gcMatchDir,
  gcRigDirOf,
  gcRun,
  gcSessionFor,
  gcState,
  gcSupervisorRunning,
  GC_AGENT_TOML,
  GC_CITY_TOML,
  GC_PROMPT_TEMPLATE,
  GC_SUBMIT_PROMPT_MAX,
  GIT_REPOSITORY_ENV_KEYS,
  infoCause,
  infoLearn,
  infoProvenance,
  listGcSessions,
  mkdirPrivateSync,
  patchAgentRegistry,
  prepareSpawn,
  readAgentRegistry,
  releaseSessionSlot,
  releaseSessionStart,
  releaseSpawnLease,
  sessionQuotaOf,
  spawnHome,
  stepParent,
  tomlStr,
  toInfo,
  withAgentRegistryLock,
  writePrivateFileSync,
  entryRunId,
} from './spawn-harness.ts';

function resetGcSession(input: { id: string; city: string }): string {
  const reset = gcRun({ args: ['session', 'reset', input.id, '--city', input.city] });
  if (reset.code !== 0) throw new Error(`gc session reset ${input.id} — ${gcErr(reset)}`);
  return input.id;
}

function createGcSession(input: { molStep: string; city: string }): string {
  const created = gcRun({
    args: [
      'session',
      'new',
      input.molStep,
      '--alias',
      input.molStep,
      '--no-attach',
      '--json',
      '--city',
      input.city,
    ],
    timeoutMs: 120_000,
  });
  if (created.code !== 0) throw new Error(`gc session new ${input.molStep} — ${gcErr(created)}`);
  let value: { session_id?: string; ok?: boolean };
  try {
    value = JSON.parse(created.out) as { session_id?: string; ok?: boolean };
  } catch {
    gcRun({ args: ['session', 'close', input.molStep, '--city', input.city] });
    throw new Error('gc session new returned unparseable JSON');
  }
  if (value.ok === false || value.session_id === undefined) {
    gcRun({ args: ['session', 'close', input.molStep, '--city', input.city] });
    throw new Error(
      value.ok === false
        ? 'gc session new returned ok: false'
        : 'gc session new returned no session_id'
    );
  }
  return value.session_id;
}

function gcEntryIsLive(
  entry: AgentRegistryEntry,
  molStep: string,
  city: string,
  snapshot: GcSession[] | undefined
): boolean {
  const snap = gcSessionFor(entry, molStep, snapshot ?? []);
  if (snap !== undefined && ['running', 'spawned'].includes(gcState(snap))) return true;
  const fresh = listGcSessions(city);
  if (fresh.sessions === undefined) {
    throw new SpawnError(
      `gascity unreachable — cannot verify existing agent: ${fresh.err}`,
      'unavailable'
    );
  }
  const session = gcSessionFor(entry, molStep, fresh.sessions);
  if (session === undefined) {
    if (gcSupervisorRunning() !== true) {
      throw new SpawnError('gc supervisor not running — agent liveness unknown', 'unavailable');
    }
    return false;
  }
  return ['running', 'spawned'].includes(gcState(session));
}

function recoverGascitySpawn(input: {
  dir: string;
  spec: SpawnSpec;
  sessionId: string | undefined;
  prepared: ReturnType<typeof prepareSpawn>;
  err: unknown;
}): never {
  const { dir, spec, sessionId, prepared, err } = input;
  if (sessionId !== undefined)
    gcRun({ args: ['session', 'close', sessionId, '--city', input.spec.molStep] });
  if (prepared.reservation !== undefined) releaseSessionSlot(prepared.reservation);
  releaseSessionStart(prepared.crossKindReservations);
  releaseSpawnLease(dir, prepared.lease);
  patchAgentRegistry(dir, spec.molStep, {
    sessionId,
    spawnError: err instanceof Error ? err.message : String(err),
  });
  const why = err instanceof Error ? err.message : String(err);
  throw err instanceof SpawnError ? err : new SpawnError(why, 'unavailable');
}

function requireGcSessions(city: string): GcSession[] {
  const result = listGcSessions(city);
  if (result.sessions === undefined) throw new Error(`gascity unreachable — ${result.err}`);
  return result.sessions;
}

function requireKnownGcAgent(
  entry: AgentRegistryEntry,
  molStep: string,
  sessions: GcSession[]
): void {
  if (gcSessionFor(entry, molStep, sessions) === undefined && gcSupervisorRunning() !== true) {
    throw new Error('gc supervisor not running — agent liveness unknown');
  }
}

async function listGascityAgents(dir: string, configDir: () => string | null): Promise<ListResult> {
  try {
    const city = configDir();
    const entries = Object.entries(readAgentRegistry(dir)).filter(
      ([, e]) => e.backend === 'gascity'
    );
    if (entries.length === 0) {
      return { agents: [] };
    }
    if (city === null || !existsSync(join(city, 'city.toml'))) {
      // never initialized — every gascity entry is unverifiable
      return { agents: [], degraded: 'gascity city not initialized' };
    }
    const { sessions, err } = listGcSessions(city);
    if (sessions === undefined) {
      return { agents: [], degraded: err };
    }
    // absent sessions are 'lost' only when the supervisor can verify;
    // not verifiably running → degrade and omit them: an unlisted
    // agent renders 'unknown' in fleet, a 'lost' one would look like
    // a dead fleet.
    if (hasUnverifiableAgents(entries, sessions)) {
      return {
        agents: knownGascityAgents(entries, sessions),
        degraded: 'gc supervisor not running — agent liveness unknown',
      };
    }
    return { agents: entries.map(([molStep, e]) => gascityInfo(molStep, e, sessions, 'lost')) };
  } catch (err) {
    return { agents: [], degraded: err instanceof Error ? err.message : String(err) };
  }
}

function hasUnverifiableAgents(
  entries: [string, AgentRegistryEntry][],
  sessions: GcSession[]
): boolean {
  return (
    entries.some(([molStep, entry]) => gcSessionFor(entry, molStep, sessions) === undefined) &&
    gcSupervisorRunning() !== true
  );
}

function knownGascityAgents(
  entries: [string, AgentRegistryEntry][],
  sessions: GcSession[]
): AgentInfo[] {
  return entries
    .filter(([molStep, entry]) => gcSessionFor(entry, molStep, sessions) !== undefined)
    .map(([molStep, entry]) => gascityInfo(molStep, entry, sessions, 'lost'));
}

function gascityInfo(
  molStep: string,
  entry: AgentRegistryEntry,
  sessions: GcSession[] | undefined,
  missing: AgentState
): AgentInfo {
  const s = sessions === undefined ? undefined : gcSessionFor(entry, molStep, sessions);
  return {
    id: entry.agentId,
    spawnedAt: typeof entry.spawnedAt === 'string' ? entry.spawnedAt : undefined,
    runId: entryRunId(entry),
    molStep,
    backend: entry.backend,
    state: sessions === undefined || s === undefined ? missing : gcState(s),
    ...infoCause(entry),
    ...infoLearn(entry),
    ...infoProvenance(entry),
    worktree: typeof entry.worktree === 'string' ? entry.worktree : undefined,
    log: typeof entry.log === 'string' ? entry.log : undefined,
  };
}

export function makeGascityConnector(ctx: ConnectorCtx, env: AgentConnectorEnv): AgentConnector {
  const dir = ctx.dir;
  const knobs = env.agents['gascity'] ?? {};
  const command =
    (typeof knobs.command === 'string' && knobs.command.trim() !== ''
      ? knobs.command
      : undefined) ??
    env.loop?.agent ??
    '';
  const template =
    typeof knobs.template === 'string' && knobs.template.trim() !== ''
      ? knobs.template.trim()
      : 'bro-worker';

  const configDir = (): string | null => gcConfigDir(dir, env);

  const findEntry = (id: string) => findAgentEntry(dir, 'gascity', id);

  /** Author city.toml + the worker template once, then `gc init --file
   *  … --no-start` — files-only bootstrap, no supervisor side effects. */
  const initCity = (city: string): void => {
    mkdirSync(city, { recursive: true });
    const toml = join(city, 'city.toml');
    if (existsSync(toml)) {
      return;
    }
    writeFileSync(toml, GC_CITY_TOML({ provider: commandCliName(command), command }));
    const agentDir = join(city, 'agents', template);
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'prompt.template.md'), GC_PROMPT_TEMPLATE);
    writeFileSync(join(agentDir, 'agent.toml'), GC_AGENT_TOML);
    const init = gcRun({
      args: [
        'init',
        '--file',
        toml,
        '--preserve-existing',
        '--no-start',
        '--skip-provider-readiness',
        '--yes',
        city,
      ],
      timeoutMs: 120_000,
    });
    if (init.code !== 0) {
      // a failed init must not leave the marker standing — otherwise the
      // next spawn sees city.toml and skips init on a half-built city
      rmSync(toml, { force: true });
      throw new SpawnError(`gc init failed — ${gcErr(init)}`, 'unavailable');
    }
  };

  /** Per-step agent — `gc sling <target> <bead>` resolves <target> as a
   *  configured agent (never a session alias), and a session's working
   *  dir comes from its agent's work_dir — so each step gets its own
   *  agent named after the molStep, pinned to spec.repoRoot. Written on
   *  every spawn; gc reads config per command. */
  const writeStepAgent = (input: {
    spec: SpawnSpec;
    city: string;
    agentId: string;
    promptFile: string;
    mol?: string;
  }): void => {
    const { spec, city, agentId, promptFile, mol } = input;
    // leading-alnum guard: '.'/'..' would escape the per-step dir and a
    // template-named step would overwrite the shared template
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(spec.molStep)) {
      throw new SpawnError(`molStep ${spec.molStep} is not a safe gascity agent name`, 'input');
    }
    // inherit a customized agents.gascity.template — its prompt and
    // agent.toml carry over; only the work_dir pin is asserted
    const tplDir = join(city, 'agents', template);
    const read = (f: string, fallback: string): string => {
      try {
        return readFileSync(join(tplDir, f), 'utf8');
      } catch {
        return fallback;
      }
    };
    const wd = `work_dir = "${tomlStr(spec.repoRoot)}"`;
    // spec.env rides the agent's env table — the only channel a gc
    // session has for caller env (gc re-injects it after its `env -u`
    // strip, so the spawned provider process actually sees the vars)
    const envEntries = Object.entries(spec.env ?? {}).filter(
      // identity pins are connector-owned — a caller value for
      // BEADS_DIR/BRO_BEAD_ID/... would redirect bead ops or re-badge
      // the worker, so the env table filters them out and re-injects
      // the connector's own below. gc injects no tmpdir pin — a caller
      // TMPDIR is the caller's to keep (envKeyDropped's unpinned leg)
      ([k]) =>
        /^[A-Za-z_]\w*$/.test(k) && !envKeyDropped(k, false) && !GIT_REPOSITORY_ENV_KEYS.has(k)
    );
    // caller env plus the connector-owned identity pins — pins always
    // render so the table exists even when spec.env is empty
    const allEnv = [
      ...envEntries,
      ...agentEnvPins(spec, agentId, promptFile, commandCliName(command), mol),
    ];
    const envToml = `env = { ${allEnv.map(([k, v]) => `${k} = "${tomlStr(v)}"`).join(', ')} }\n`;
    // work_dir (+ env) are top-level — they must precede any [table] in
    // the file; the template's own copies are dropped so ours win
    const agentToml =
      `${wd}\n${envToml}` +
      read('agent.toml', GC_AGENT_TOML)
        .replace(/^work_dir\s*=.*$/gm, '')
        .replace(/^env\s*=.*$/gm, '');
    const agentDir = join(city, 'agents', spec.molStep);
    // owner-only (spec bro-l8c4f.4) — agent.toml inlines the caller's
    // env table; a permissive file leaks secrets into every local login
    mkdirPrivateSync({ path: agentDir });
    writePrivateFileSync({
      path: join(agentDir, 'prompt.template.md'),
      data: read('prompt.template.md', GC_PROMPT_TEMPLATE),
    });
    writePrivateFileSync({ path: join(agentDir, 'agent.toml'), data: agentToml });
  };

  /** Adopt the repo as a rig — the rig's beads DB IS the shared store,
   *  so claims land where `bro fleet` reads. Idempotent. */
  const ensureRig = (spec: SpawnSpec, city: string): void => {
    const rigDir = gcRigDirOf(spec);
    const rigs = gcRun({ args: ['rig', 'list', '--json', '--city', city] });
    let registered = false;
    if (rigs.code === 0) {
      try {
        const v = JSON.parse(rigs.out) as { rigs?: { path?: string }[] };
        registered = (v.rigs ?? []).some(r => r.path === rigDir);
      } catch {
        registered = false;
      }
    }
    if (!registered) {
      const add = gcRun({
        args: ['rig', 'add', rigDir, '--adopt', '--city', city],
        timeoutMs: 60_000,
      });
      if (add.code !== 0) {
        throw new SpawnError(`gc rig add ${rigDir} failed — ${gcErr(add)}`, 'unavailable');
      }
    }
  };

  /** City-scoped supervisor ensure — `gc start` registers the city and
   *  brings up the shared supervisor. */
  const ensureStarted = (city: string): void => {
    if (gcSupervisorRunning() !== true) {
      const start = gcRun({ args: ['start', city], timeoutMs: 120_000 });
      if (start.code !== 0) {
        throw new SpawnError(`gc start failed — ${gcErr(start)}`, 'unavailable');
      }
    }
  };

  const toInfo = (
    molStep: string,
    entry: AgentRegistryEntry,
    sessions: GcSession[] | undefined,
    missing: AgentState
  ): AgentInfo => {
    const s = sessions === undefined ? undefined : gcSessionFor(entry, molStep, sessions);
    return {
      id: entry.agentId,
      spawnedAt: typeof entry.spawnedAt === 'string' ? entry.spawnedAt : undefined,
      runId: entryRunId(entry),
      molStep,
      backend: entry.backend,
      state: sessions === undefined || s === undefined ? missing : gcState(s),
      ...infoCause(entry),
      ...infoLearn(entry),
      ...infoProvenance(entry),
      worktree: typeof entry.worktree === 'string' ? entry.worktree : undefined,
      log: typeof entry.log === 'string' ? entry.log : undefined,
    };
  };

  /** Bring the city up and return the session id — `session reset` a
   *  surviving session in place (preserves alias+bead), else `session
   *  new` the per-step agent. A `session new` whose id can't be learned
   *  is closed by alias first so no orphan runs beside the retry. */
  const ensureGcSession = (input: {
    spec: SpawnSpec;
    city: string;
    prior: unknown;
    agentId: string;
    promptFile: string;
    mol?: string;
  }): string => {
    const { spec, city, prior, agentId, promptFile, mol } = input;
    initCity(city);
    writeStepAgent({ spec, city, agentId, promptFile, mol });
    ensureRig(spec, city);
    ensureStarted(city);
    const priorId = typeof prior === 'string' ? prior : undefined;
    const alive = listGcSessions(city).sessions?.find(
      s => s.id === priorId || s.alias === spec.molStep
    );
    return alive === undefined
      ? createGcSession({ molStep: spec.molStep, city })
      : resetGcSession({ id: alive.id, city });
  };

  /** Route + deliver: sling the bead (the routed work order), then
   *  submit the rendered prompt. Never --force — a bead that doesn't
   *  resolve in the rig store is a claimless dispatch. */
  const dispatchStep = (spec: SpawnSpec, city: string): void => {
    const sling = gcRun({ args: ['sling', spec.molStep, spec.molStep, '--city', city] });
    if (sling.code !== 0) {
      throw new Error(`gc sling ${spec.molStep} — ${gcErr(sling)}`);
    }
    const submit = gcRun({
      args: ['session', 'submit', spec.molStep, spec.prompt, '--city', city],
    });
    if (submit.code !== 0) {
      throw new Error(`gc session submit ${spec.molStep} — ${gcErr(submit)}`);
    }
  };

  /** `close` is the terminal op — `kill` races the reconciler's restart.
   *  A failed close is tolerated only when the session is verifiably
   *  gone — marking stopped while it still runs would leave a live
   *  worker that respawns refuse as a duplicate. */
  const closeGcSession = (city: string, target: string, molStep: string): void => {
    const close = gcRun({ args: ['session', 'close', target, '--city', city] });
    if (close.code === 0) {
      return;
    }
    const { sessions } = listGcSessions(city);
    const s = sessions?.find(x => x.id === target || x.alias === molStep);
    if (s === undefined ? sessions === undefined : gcState(s) !== 'exited') {
      throw new Error(`gc session close ${target} — ${gcErr(close)}`);
    }
  };

  const spawnLocked = (input: {
    spec: SpawnSpec;
    city: string;
    home: string;
    mol: string | undefined;
    preSessions: ReturnType<typeof listGcSessions> | undefined;
  }): AgentRegistryEntry => {
    const { spec, city, home, mol, preSessions } = input;
    return withAgentRegistryLock(dir, () => {
      const existing = readAgentRegistry(dir)[spec.molStep];
      const prepared = prepareSpawn(dir, home, 'gascity', spec, {
        isLive: e => gcEntryIsLive(e, spec.molStep, city, preSessions?.sessions),
        liveDetail: e => `session ${typeof e.sessionId === 'string' ? e.sessionId : spec.molStep}`,
        entry: () => ({ sessionId: undefined }),
        claimAs: spec.molStep,
        cap: { max: fleetCapOf(env), env },
        env,
        sessionQuota: () => sessionQuotaOf(env, 'gascity', spec, gcEffectiveCommand(city, command)),
        spawnCommand: gcEffectiveCommand(city, command),
        external: externalGuardOf(env),
      });
      let sessionId: string | undefined;
      try {
        sessionId = ensureGcSession({
          spec,
          city,
          prior: existing?.sessionId,
          agentId: prepared.agentId,
          promptFile: prepared.promptFile,
          mol,
        });
        dispatchStep(spec, city);
      } catch (err) {
        recoverGascitySpawn({ dir, spec, sessionId, prepared, err });
      }
      return patchAgentRegistry(dir, spec.molStep, { sessionId });
    });
  };

  return {
    name: 'gascity',

    // instance-level view of the registered factory matcher
    matchDir: () => gcMatchDir(dir, env),

    async spawn(spec: SpawnSpec): Promise<AgentInfo> {
      // policy before preflight — refuse invalid committed config ahead
      // of the worker/prompt checks, let alone the gc side effects
      assertMutableConfig(dir);
      // a provider-resolved worker can't ride gc — the city's provider
      // command is written once in city.toml at init, so recording
      // provenance while gc runs its own configured provider would be
      // laundering. Model labels alone still pin (env table).
      if (spec.worker !== undefined) {
        throw new SpawnError(
          `providers.${spec.provider ?? '?'} resolved a spawn worker, but the gascity backend runs its own provider sessions (city.toml owns the command) — run it on native/tmux or drop the provider`,
          'config'
        );
      }
      // gc session submit has no --file/stdin mode (v1.4.2), so the
      // prompt rides argv — Linux caps a single element at 128KiB
      // (MAX_ARG_STRLEN) and E2BIG there reads as an opaque spawn
      // failure. Bound it as bad input before claiming or touching gc.
      const promptBytes = Buffer.byteLength(spec.prompt);
      if (promptBytes > GC_SUBMIT_PROMPT_MAX) {
        throw new SpawnError(
          `prompt is ${promptBytes} bytes — gc session submit passes it as one argv element (cap ${GC_SUBMIT_PROMPT_MAX}); shorten the prompt or file it`,
          'input'
        );
      }
      const home = spawnHome(dir, 'gascity', command, spec);
      const city = configDir();
      if (city === null) {
        throw new SpawnError(`no git common dir for ${spec.repoRoot}`, 'config');
      }
      // same TOCTOU critical section as native: dedup → claim → backend
      // spawn → registry patch, all under the agents.json lock — and the
      // molecule pin's bd show resolves before it, off the critical path
      const mol = stepParent(spec.beadsDir, spec.molStep);
      // gc round-trips are blocking subprocesses — the session list
      // prefetches BEFORE the registry lock whenever the step already
      // owns an entry, so the critical section never serializes
      // concurrent spawns/status on gc latency in the common case.
      // But a pre-lock snapshot can only prove LIFE, never loss: the
      // unlocked registry read above can observe an entry while its
      // creator still holds the lock building the session, so a
      // snapshot missing that session may simply predate it. A live
      // verdict may ride the snapshot; a lost verdict re-probes under
      // the lock (kody's lock-latency fix and coderabbit's stale-read
      // race both hold under this rule).
      const priorEntry = readAgentRegistry(dir)[spec.molStep];
      const preSessions = priorEntry === undefined ? undefined : listGcSessions(city);
      const spawned = spawnLocked({ spec, city, home, mol, preSessions });
      // the session list rides AFTER the lock — it must see the session
      // just dispatched, and a gc round-trip never holds agents.json.
      // A failed list passes undefined → 'spawned' (the contract's
      // registered-unverified state), not a faked live read.
      const { sessions } = listGcSessions(city);
      return toInfo(spec.molStep, spawned, sessions, 'spawned');
    },

    async list(): Promise<ListResult> {
      return listGascityAgents(dir, configDir);
    },

    async status(id: string): Promise<AgentInfo> {
      const hit = findEntry(id);
      if (!hit) {
        throw new AgentNotFound(`no gascity agent ${id}`);
      }
      const [molStep, entry] = hit;
      const city = configDir();
      if (city === null) {
        throw new Error('no git common dir — cannot reach gascity');
      }
      const sessions = requireGcSessions(city);
      requireKnownGcAgent(entry, molStep, sessions);
      return toInfo(molStep, entry, sessions, 'lost');
    },

    async stop(id: string): Promise<void> {
      const hit = findEntry(id);
      if (!hit) {
        return; // idempotent — gone is the desired end state
      }
      const [molStep, entry] = hit;
      const city = configDir();
      if (city !== null && entry.stopped !== true) {
        closeGcSession(
          city,
          typeof entry.sessionId === 'string' ? entry.sessionId : molStep,
          molStep
        );
      }
      try {
        patchAgentRegistry(dir, molStep, { stopped: true });
      } catch {
        // stop intent is recorded best-effort, same as native
      }
    },

    /** supervisor:'required' ⇒ up/down are `gc start`/`gc stop <city>`
     *  — city-scoped lifecycle; the machine-wide supervisor itself is
     *  never touched (other cities ride it). */
    async up(): Promise<void> {
      const city = configDir();
      if (city === null) {
        throw new SpawnError('no git common dir — cannot locate the gascity city', 'config');
      }
      if (command === '') {
        throw new SpawnError(
          'no agent command configured — set agents.gascity.command or loop.agent in bro.config.json',
          'config'
        );
      }
      initCity(city);
      ensureStarted(city);
    },

    async down(): Promise<void> {
      const city = configDir();
      // an uninitialized city has nothing to stop — idempotent down
      if (city === null || !existsSync(join(city, 'city.toml'))) {
        return;
      }
      const r = gcRun({ args: ['stop', city], timeoutMs: 120_000 });
      if (r.code !== 0) {
        throw new SpawnError(`gc stop failed — ${gcErr(r)}`, 'unavailable');
      }
    },

    capabilities: () => ({ attach: true, respawn: true, workers: false, supervisor: 'required' }),
  };
}
