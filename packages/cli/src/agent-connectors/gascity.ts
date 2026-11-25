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
import type { AgentConnectorEnv, AgentState, GcSession, ListResult } from './core.ts';
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
  registerAgentConnector,
} from './core.ts';

function resetGcSession(input: { id: string; city: string }): string {
  const reset = gcRun({ args: ['session', 'reset', input.id, '--city', input.city] });
  if (reset.code !== 0) throw new Error(`gc session reset ${input.id} — ${gcErr(reset)}`);
  return input.id;
}

function createGcSession(input: { molStep: string; city: string }): string {
  const created = gcRun(createGcSessionRun(input));
  if (created.code !== 0) throw new Error(`gc session new ${input.molStep} — ${gcErr(created)}`);
  try {
    return createdGcSessionId(parseGcSession(created.out));
  } catch (err) {
    closeGcSession(input);
    throw err;
  }
}

function createGcSessionRun(input: { molStep: string; city: string }): {
  args: string[];
  timeoutMs: number;
} {
  return {
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
  };
}

function closeGcSession(input: { molStep: string; city: string }): void {
  gcRun({ args: ['session', 'close', input.molStep, '--city', input.city] });
}

function createdGcSessionId(value: { session_id?: string; ok?: boolean }): string {
  if (value.ok === false) throw new Error('gc session new returned ok: false');
  if (value.session_id === undefined) throw new Error('gc session new returned no session_id');
  return value.session_id;
}

function parseGcSession(output: string): { session_id?: string; ok?: boolean } {
  try {
    return JSON.parse(output) as { session_id?: string; ok?: boolean };
  } catch {
    throw new Error('gc session new returned unparseable JSON');
  }
}

function gcEntryIsLive(input: {
  entry: AgentRegistryEntry;
  molStep: string;
  city: string;
  snapshot: GcSession[] | undefined;
}): boolean {
  const { entry, molStep, city, snapshot } = input;
  const snap = gcSessionFor(entry, molStep, snapshot ?? []);
  if (snap !== undefined) return gcSessionIsActive(snap);
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
  return gcSessionIsActive(session);
}

function gcSessionIsActive(session: GcSession): boolean {
  return ['running', 'spawned'].includes(gcState(session));
}

function recoverGascitySpawn(input: {
  dir: string;
  spec: SpawnSpec;
  city: string;
  sessionId: string | undefined;
  prepared: ReturnType<typeof prepareSpawn>;
  err: unknown;
}): never {
  const { dir, spec, city, sessionId, prepared, err } = input;
  if (sessionId !== undefined) gcRun({ args: ['session', 'close', sessionId, '--city', city] });
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

function requireGcSessions(input: { city: string }): GcSession[] {
  const result = listGcSessions(input.city);
  if (result.sessions === undefined) throw new Error(`gascity unreachable — ${result.err}`);
  return result.sessions;
}

function requireKnownGcAgent(input: {
  entry: AgentRegistryEntry;
  molStep: string;
  sessions: GcSession[];
}): void {
  const { entry, molStep, sessions } = input;
  if (gcSessionFor(entry, molStep, sessions) === undefined && gcSupervisorRunning() !== true) {
    throw new Error('gc supervisor not running — agent liveness unknown');
  }
}

async function listGascityAgents(dir: string, configDir: () => string | null): Promise<ListResult> {
  try {
    return listGascityAgentsOnce({ dir, city: configDir() });
  } catch (err) {
    return { agents: [], degraded: err instanceof Error ? err.message : String(err) };
  }
}

function listGascityAgentsOnce(input: { dir: string; city: string | null }): ListResult {
  const { dir, city } = input;
  const entries = Object.entries(readAgentRegistry(dir)).filter(([, e]) => e.backend === 'gascity');
  if (entries.length === 0) return { agents: [] };
  if (city === null || !existsSync(join(city, 'city.toml'))) {
    return { agents: [], degraded: 'gascity city not initialized' };
  }
  return listGascitySessions({ entries, city });
}

function listGascitySessions(input: {
  entries: [string, AgentRegistryEntry][];
  city: string;
}): ListResult {
  const { entries, city } = input;
  const { sessions, err } = listGcSessions(city);
  if (sessions === undefined) return { agents: [], degraded: err };
  if (hasUnverifiableAgents(entries, sessions)) {
    return {
      agents: knownGascityAgents(entries, sessions),
      degraded: 'gc supervisor not running — agent liveness unknown',
    };
  }
  return {
    agents: entries.map(([molStep, entry]) =>
      gascityInfo({ molStep, entry, sessions, missing: 'lost' })
    ),
  };
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
    .map(([molStep, entry]) => gascityInfo({ molStep, entry, sessions, missing: 'lost' }));
}

function gascityInfo(input: {
  molStep: string;
  entry: AgentRegistryEntry;
  sessions: GcSession[] | undefined;
  missing: AgentState;
}): AgentInfo {
  const { molStep, entry, sessions, missing } = input;
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

function assertSafeGcAgentName(molStep: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(molStep)) {
    throw new SpawnError(`molStep ${molStep} is not a safe gascity agent name`, 'input');
  }
}

function validateGascitySpawn(spec: SpawnSpec): void {
  if (spec.worker !== undefined) {
    throw new SpawnError(
      `providers.${spec.provider ?? '?'} resolved a spawn worker, but the gascity backend runs its own provider sessions (city.toml owns the command) — run it on native/tmux or drop the provider`,
      'config'
    );
  }
  const promptBytes = Buffer.byteLength(spec.prompt);
  if (promptBytes > GC_SUBMIT_PROMPT_MAX) {
    throw new SpawnError(
      `prompt is ${promptBytes} bytes — gc session submit passes it as one argv element (cap ${GC_SUBMIT_PROMPT_MAX}); shorten the prompt or file it`,
      'input'
    );
  }
}

function gcAgentToml(input: {
  spec: SpawnSpec;
  templateDir: string;
  agentId: string;
  promptFile: string;
  command: string;
  mol: string | undefined;
}): string {
  const { spec, templateDir, agentId, promptFile, command, mol } = input;
  const envEntries = gcEnvEntries(spec);
  const allEnv = [
    ...envEntries,
    ...agentEnvPins(spec, agentId, promptFile, commandCliName(command), mol),
  ];
  const envToml = `env = { ${allEnv.map(([key, value]) => `${key} = "${tomlStr(value)}"`).join(', ')} }\n`;
  return (
    `work_dir = "${tomlStr(spec.repoRoot)}"\n${envToml}` +
    gcTemplateFile({ templateDir, file: 'agent.toml', fallback: GC_AGENT_TOML })
      .replace(/^work_dir\s*=.*$/gm, '')
      .replace(/^env\s*=.*$/gm, '')
  );
}

function gcEnvEntries(spec: SpawnSpec): [string, string][] {
  return Object.entries(spec.env ?? {}).filter(([key]) => gcEnvKeyIsAllowed(key));
}

function gcEnvKeyIsAllowed(key: string): boolean {
  return (
    /^[A-Za-z_]\w*$/.test(key) && !envKeyDropped(key, false) && !GIT_REPOSITORY_ENV_KEYS.has(key)
  );
}

function gcTemplateFile(input: { templateDir: string; file: string; fallback: string }): string {
  try {
    return readFileSync(join(input.templateDir, input.file), 'utf8');
  } catch {
    return input.fallback;
  }
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
  const initCity = (input: { city: string }): void => {
    const { city } = input;
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
    assertSafeGcAgentName(spec.molStep);
    const tplDir = join(city, 'agents', template);
    const agentToml = gcAgentToml({
      spec,
      templateDir: tplDir,
      agentId,
      promptFile,
      command,
      mol,
    });
    const agentDir = join(city, 'agents', spec.molStep);
    // owner-only (spec bro-l8c4f.4) — agent.toml inlines the caller's
    // env table; a permissive file leaks secrets into every local login
    mkdirPrivateSync({ path: agentDir });
    writePrivateFileSync({
      path: join(agentDir, 'prompt.template.md'),
      data: gcTemplateFile({
        templateDir: tplDir,
        file: 'prompt.template.md',
        fallback: GC_PROMPT_TEMPLATE,
      }),
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
  const ensureStarted = (input: { city: string }): void => {
    const { city } = input;
    if (gcSupervisorRunning() !== true) {
      const start = gcRun({ args: ['start', city], timeoutMs: 120_000 });
      if (start.code !== 0) {
        throw new SpawnError(`gc start failed — ${gcErr(start)}`, 'unavailable');
      }
    }
  };

  const toInfo = (input: {
    molStep: string;
    entry: AgentRegistryEntry;
    sessions: GcSession[] | undefined;
    missing: AgentState;
  }): AgentInfo => {
    const { molStep, entry, sessions, missing } = input;
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
    initCity({ city });
    writeStepAgent({ spec, city, agentId, promptFile, mol });
    ensureRig(spec, city);
    ensureStarted({ city });
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
        isLive: entry =>
          gcEntryIsLive({
            entry,
            molStep: spec.molStep,
            city,
            snapshot: preSessions?.sessions,
          }),
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
        recoverGascitySpawn({ dir, spec, city, sessionId, prepared, err });
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
      validateGascitySpawn(spec);
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
      return toInfo({ molStep: spec.molStep, entry: spawned, sessions, missing: 'spawned' });
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
      const sessions = requireGcSessions({ city });
      requireKnownGcAgent({ entry, molStep, sessions });
      return toInfo({ molStep, entry, sessions, missing: 'lost' });
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
      initCity({ city });
      ensureStarted({ city });
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

registerAgentConnector('gascity', makeGascityConnector, {}, { builtin: true });
