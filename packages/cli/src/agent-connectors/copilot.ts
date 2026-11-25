import { assertMutableConfig } from '../config-policy.ts';
import { join, resolve } from 'node:path';
import { copilotRemoteRepo, copilotHeadRef, copilotEntryRepo } from './copilot-refs.ts';
import { copilotLatestSession } from './copilot-tasks.ts';
import { dropWorkMarker } from './work-markers.ts';
import { SpawnError } from '@broject/core';
import { type CopilotTask, copilotTaskIdOf, copilotTaskState } from './copilot-tasks.ts';
import type { AgentConnector, AgentInfo, ConnectorCtx, SpawnSpec } from './types.ts';
import * as harness from './spawn-harness.ts';
const {
  AgentNotFound,
  COPILOT_LIVE_STATES,
  agentsHome,
  claimStep,
  copilotFetchTask,
  copilotInfoFor,
  copilotRefreshCount,
  copilotSessionQuota,
  copilotSessionUrl,
  copilotTaskProbe,
  existsSync,
  externalGuardOf,
  findAgentEntry,
  fleetCapOf,
  ghHost,
  ghRun,
  infoProvenance,
  patchAgentRegistry,
  prepareSpawn,
  readAgentRegistry,
  refuseCopilotWorker,
  releaseSessionSlot,
  releaseSessionStart,
  releaseSpawnLease,
  spawn,
  toCopilotInfo,
  withAgentRegistryLock,
  writePrivateFileSync,
  writeWorkMarker,
} = harness;
type AgentConnectorEnv = harness.AgentConnectorEnv;
type AgentRegistryEntry = harness.AgentRegistryEntry;
type ListResult = harness.ListResult;

export function makeCopilotConnector(ctx: ConnectorCtx, env: AgentConnectorEnv): AgentConnector {
  const dir = ctx.dir;
  const knobs = env.agents['copilot'] ?? {};
  const knobString = (k: string): string | undefined =>
    typeof knobs[k] === 'string' && knobs[k] !== '' ? (knobs[k] as string) : undefined;

  const findEntry = (id: string) => findAgentEntry(dir, 'copilot', id);

  /** 'owner/repo' the dispatch targets — agents.copilot.repo wins over
   *  the checkout's origin remote; neither resolvable is a config gap
   *  the error names. */
  const targetRepo = (spec: SpawnSpec): { owner: string; repo: string; slug: string } => {
    const slug = knobString('repo') ?? copilotRemoteRepo(spec.repoRoot);
    const m = slug === undefined ? null : /^([\w.-]+)\/([\w.-]+)$/.exec(slug);
    if (!isRepoMatch(m, slug)) {
      throw new SpawnError(
        `no repository to dispatch the copilot task against — set agents.copilot.repo ` +
          `('owner/repo') or an origin remote on ${spec.repoRoot}`,
        'config'
      );
    }
    return { owner: m[1], repo: m[2], slug: slug! };
  };

  const isRepoMatch = (
    match: RegExpExecArray | null,
    slug: string | undefined
  ): match is RegExpExecArray & { 1: string; 2: string } =>
    slug !== undefined && match?.[1] !== undefined && match[2] !== undefined;

  /** The REST POST — `gh agent-task create` prints only a human URL;
   *  the task object's `id` has to come back typed or the registry
   *  couldn't pin the remote handle. base_ref absent = the API's repo
   *  default (documented). The body rides a file in the agents home
   *  like the prompt — never argv. */
  const dispatchTask = (
    home: string,
    agentId: string,
    spec: SpawnSpec,
    target: { owner: string; repo: string; slug: string }
  ): { task: CopilotTask; taskId: string } => {
    const bodyFile = join(home, `${agentId}.task.json`);
    writePrivateFileSync({ path: bodyFile, data: JSON.stringify(copilotTaskBody(spec)) });
    const res = ghRun(
      [
        'api',
        '-X',
        'POST',
        `agents/repos/${target.owner}/${target.repo}/tasks`,
        '--input',
        bodyFile,
      ],
      60_000
    );
    return parseDispatchResult(res, target.slug);
  };

  const parseDispatchResult = (
    res: ReturnType<typeof ghRun>,
    slug: string
  ): { task: CopilotTask; taskId: string } => {
    validateDispatchResponse(res, slug);
    const orphan = `the task may still have been created; check \`gh agent-task list\` on ${slug}`;
    let task: CopilotTask;
    try {
      task = JSON.parse(res.out) as CopilotTask;
    } catch {
      throw new SpawnError(
        `copilot task dispatch returned unparseable JSON — ${orphan}`,
        'unavailable'
      );
    }
    if (typeof task.id !== 'string')
      throw new SpawnError(`copilot task dispatch returned no task id — ${orphan}`, 'unavailable');
    return { task, taskId: task.id };
  };

  const validateDispatchResponse = (res: ReturnType<typeof ghRun>, slug: string): void => {
    if (res.missing) throw new SpawnError('gh not on PATH', 'unavailable');
    if (res.code !== 0) {
      throw dispatchFailure(slug, res.err !== '' ? res.err : `gh api exited ${res.code}`);
    }
  };

  const copilotTaskBody = (spec: SpawnSpec): Record<string, unknown> => ({
    prompt: spec.prompt,
    create_pull_request: true,
    ...(knobString('base') !== undefined ? { base_ref: knobString('base') } : {}),
    ...((spec.model ?? knobString('model')) !== undefined
      ? { model: spec.model ?? knobString('model') }
      : {}),
    ...(knobString('customAgent') !== undefined ? { custom_agent: knobString('customAgent') } : {}),
  });

  /** Why a dispatch failed — a transport/body-shape error is quoted
   *  raw; anything else is almost always the coding agent not being
   *  enabled on the repo, so the error names the prerequisites. */
  const dispatchFailure = (slug: string, err: string): SpawnError =>
    new SpawnError(
      /unable to|could not resolve|connection|timed out|ECONN|ENOTFOUND|EAI_AGAIN|HTTP 5/i.test(err)
        ? `copilot task dispatch failed — ${err}`
        : `copilot task dispatch failed on ${slug} — prerequisites: the Copilot coding ` +
            `agent enabled for the repository (a Copilot plan seat, the org policy, and ` +
            `Actions on): ${err}`,
      'unavailable'
    );

  /** Best-effort remote cancel — the documented gap: no CLI/REST task
   *  cancel exists, the backing Actions run is the only handle. A live
   *  task with a workflow run gets POST cancel; the re-read then
   *  reports a survivor or an unverifiable read (cancel is async
   *  server-side) — silence would hide it. */
  const copilotCancelRemote = (
    molStep: string,
    entry: AgentRegistryEntry,
    taskId: string
  ): void => {
    const f = copilotFetchTask(taskId);
    if (!f.ok) {
      console.error(
        `warning: cannot verify copilot task ${taskId} — ${f.err ?? 'gh api failed'}; ` +
          `the registry still records stopped; if the session survives, stop it in ` +
          `the web UI (https://${ghHost()}/copilot/agents)`
      );
      return;
    }
    if (!COPILOT_LIVE_STATES.has(copilotTaskState(f.task!))) {
      return;
    }
    const repo = copilotEntryRepo(entry);
    cancelCopilotRun(repo, f.task!);
    const after = copilotFetchTask(taskId);
    warnIfCopilotSurvives({ molStep, taskId, repo, entry, after });
  };

  const cancelCopilotRun = (repo: string | undefined, task: CopilotTask): void => {
    const runId = copilotLatestSession(task)?.workflow_run_id;
    if (repo !== undefined && typeof runId === 'number') {
      ghRun(['api', '-X', 'POST', `repos/${repo}/actions/runs/${runId}/cancel`]);
    }
  };

  const warnIfCopilotSurvives = (input: {
    molStep: string;
    taskId: string;
    repo: string | undefined;
    entry: AgentRegistryEntry;
    after: ReturnType<typeof copilotFetchTask>;
  }): void => {
    const { molStep, taskId, repo, entry, after } = input;
    if (after.ok && !COPILOT_LIVE_STATES.has(copilotTaskState(after.task!))) return;
    const url =
      copilotSessionUrl(repo, entry.pr, entry.sessionId) ?? `https://${ghHost()}/copilot/agents`;
    console.error(
      after.ok
        ? `warning: copilot session for ${molStep} is still live — there is no CLI/REST cancel; stop it in the web UI (${url})`
        : `warning: cannot re-check copilot task ${taskId} after cancel — ${after.err ?? 'gh api failed'}; the session may still be live — stop it in the web UI (${url})`
    );
  };

  const preflightCopilot = (
    spec: SpawnSpec
  ): { home: string; target: { owner: string; repo: string; slug: string } } => {
    assertMutableConfig(dir);
    refuseCopilotWorker(spec);
    if (!existsSync(spec.repoRoot)) {
      throw new SpawnError(`worktree ${spec.repoRoot} does not exist`, 'input');
    }
    const home = agentsHome(dir);
    if (home === null) {
      throw new SpawnError(`no git common dir for ${spec.repoRoot}`, 'config');
    }
    return { home, target: targetRepo(spec) };
  };

  const finishCopilotSpawn = (
    spec: SpawnSpec,
    home: string,
    target: { owner: string; repo: string; slug: string },
    agentId: string
  ): AgentInfo => {
    const { task, taskId } = dispatchTask(home, agentId, spec, target);
    const state = copilotTaskState(task);
    const spawned = patchAgentRegistry(dir, spec.molStep, {
      taskId,
      taskRepo: target.slug,
      taskState: state !== '' ? state : undefined,
      branch: copilotHeadRef(task),
    });
    writeWorkMarker(dir, agentId, spec.molStep);
    copilotRefreshCount(dir, env);
    return {
      id: agentId,
      spawnedAt: typeof spawned.spawnedAt === 'string' ? spawned.spawnedAt : undefined,
      molStep: spec.molStep,
      backend: 'copilot',
      state:
        state === 'in_progress' || state === 'idle' || state === 'waiting_for_user'
          ? 'running'
          : 'spawned',
      ...infoProvenance(spawned),
      worktree: resolve(spec.repoRoot),
      log: copilotSessionUrl(target.slug, spawned.pr, spawned.sessionId),
    };
  };

  const releaseCopilotSpawn = (input: {
    err: unknown;
    spec: SpawnSpec;
    reservation: Parameters<typeof releaseSessionSlot>[0] | undefined;
    crossKindReservations: Parameters<typeof releaseSessionStart>[0];
    lease: Parameters<typeof releaseSpawnLease>[1];
  }): never => {
    const { err, spec, reservation, crossKindReservations, lease } = input;
    copilotRefreshCount(dir, env);
    if (reservation !== undefined) releaseSessionSlot(reservation);
    releaseSessionStart(crossKindReservations);
    releaseSpawnLease(dir, lease);
    try {
      patchAgentRegistry(dir, spec.molStep, {
        spawnError: err instanceof Error ? err.message : String(err),
      });
    } catch {
      // the entry landed already — the SpawnError still reports
    }
    throw err;
  };

  return {
    name: 'copilot',

    async spawn(spec: SpawnSpec): Promise<AgentInfo> {
      const { home, target } = preflightCopilot(spec);
      // refresh the remote count BEFORE admission — a first-ever spawn
      // on a reachable API must not fail closed on an absent cache;
      // unreachable stays fail-closed by the same path. Outside the
      // lock: the fetch must not stall the registry critical section
      copilotRefreshCount(dir, env);
      return withAgentRegistryLock(dir, () => {
        // claim-on-behalf is prepareSpawn's claimStep inside this lock —
        // the remote runner can never reach the shared store, so the
        // orchestrator pins the claim BEFORE the task exists
        const {
          agentId,
          promptFile: _promptFile,
          lease,
          reservation,
          crossKindReservations,
        } = prepareSpawn(dir, home, 'copilot', spec, {
          isLive: existing => {
            const p = copilotTaskProbe(dir, spec.molStep, existing);
            if (p.live === 'unknown') {
              // an unverifiable probe must not let a duplicate spawn
              // burn beside a remote task that may still be alive
              throw new SpawnError(
                `cannot verify ${spec.molStep}'s copilot task — ${p.err ?? 'gh api failed'}`,
                'unavailable'
              );
            }
            return p.live === 'running';
          },
          liveDetail: e => `task ${copilotTaskIdOf(e) ?? '?'}`,
          entry: () => ({
            // respawn clears the previous run's remote handles — a new
            // task mints fresh ones; stale pins must not alias it
            taskId: undefined,
            taskRepo: undefined,
            taskState: undefined,
            branch: undefined,
            sessionId: undefined,
            sessionUrl: undefined,
            workflowRun: undefined,
            pr: undefined,
            prUrl: undefined,
            attach: undefined,
            log: undefined,
            // no local worker — nothing splits into the capture, so
            // the entry must not name a .stderr nobody will write
            stderrLog: undefined,
            stderrFrom: undefined,
          }),
          cap: { max: fleetCapOf(env), env },
          sessionQuota: copilotSessionQuota(env),
          external: externalGuardOf(env),
        });
        try {
          return finishCopilotSpawn(spec, home, target, agentId);
        } catch (err) {
          return releaseCopilotSpawn({ err, spec, reservation, crossKindReservations, lease });
        }
      });
    },

    async list(): Promise<ListResult> {
      // NOSONAR — connector contract is async; the work is sync
      try {
        const home = agentsHome(dir);
        const entries = Object.entries(readAgentRegistry(dir)).filter(
          ([, e]) => e.backend === 'copilot'
        );
        // the remote count refresh rides every read — the plane counts
        // REMOTE tasks whether or not this repo's registry spawned them;
        // armed-quota gate inside keeps an unarmed config gh-free
        copilotRefreshCount(dir, env);
        if (entries.length === 0) {
          // no copilot agents registered — the fleet view must not pay
          // a gh call (or a degradation) for a backend it never used
          return { agents: [] };
        }
        // per-entry reads — each task's state + harvest is one GET; a
        // failed one degrades the row's verdict to 'spawned' rather
        // than reporting a corpse, and marks the whole list degraded
        const agents: AgentInfo[] = [];
        let degraded: string | undefined;
        for (const [molStep, e] of entries) {
          const p = copilotTaskProbe(dir, molStep, e);
          if (p.err !== undefined) {
            degraded = degraded === undefined ? p.err : degraded;
          }
          agents.push(copilotInfoFor(dir, home, molStep, e, p));
        }
        return degraded === undefined ? { agents } : { agents, degraded };
      } catch (err) {
        return {
          agents: [],
          degraded: err instanceof Error ? err.message : String(err),
        };
      }
    },

    async status(id: string): Promise<AgentInfo> {
      // NOSONAR — connector contract is async; the work is sync
      const hit = findEntry(id);
      if (!hit) {
        throw new AgentNotFound(`no copilot agent ${id}`);
      }
      copilotRefreshCount(dir, env);
      return toCopilotInfo(dir, agentsHome(dir), hit[0], hit[1]);
    },

    async stop(id: string): Promise<void> {
      const hit = findEntry(id);
      if (!hit) {
        return; // idempotent — gone is the desired end state
      }
      const [molStep, entry] = hit;
      const taskId = copilotTaskIdOf(entry);
      cancelCopilotIfNeeded(molStep, entry, taskId);
      // a respawn during the cancel re-probes and re-pins the entry
      // under the registry lock — re-verify under the SAME lock or
      // 'stopped' lands on a live, respawned entry. Remote-liveness
      // can't gate the stamp the way docker's container probe does —
      // cancel is best-effort by contract, so the stamp records intent
      // and the warn above reports the survivor
      withAgentRegistryLock(dir, () => {
        const cur = readAgentRegistry(dir)[molStep];
        if (!sameCopilotRun(cur, entry)) {
          return; // respawned — the live run owns the entry
        }
        try {
          patchAgentRegistry(dir, molStep, { stopped: true });
        } catch {
          // the marker removal below still records intent
        }
        dropWorkMarker(dir, molStep, entry);
      });
    },

    capabilities: () => ({ attach: true, respawn: true, workers: false, supervisor: 'none' }),
  };

  const shouldCancelCopilot = (entry: AgentRegistryEntry, taskId: string | undefined): boolean =>
    entry.stopped !== true && taskId !== undefined;

  const sameCopilotRun = (
    current: AgentRegistryEntry | undefined,
    original: AgentRegistryEntry
  ): boolean =>
    current !== undefined &&
    current.agentId === original.agentId &&
    current.spawnedAt === original.spawnedAt;

  const cancelCopilotIfNeeded = (
    molStep: string,
    entry: AgentRegistryEntry,
    taskId: string | undefined
  ): void => {
    if (shouldCancelCopilot(entry, taskId)) copilotCancelRemote(molStep, entry, taskId!);
  };
}
