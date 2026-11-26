import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { bdActor } from '@broject/core';
import { assertMutableConfig } from '../config-policy.ts';
import type { AgentConnectorEnv } from './core.ts';
import {
  AgentNotFound,
  agentsHome,
  commitSpawn,
  externalGuardOf,
  findAgentEntry,
  fleetCapOf,
  markStoppedEntry,
  prepareSpawn,
  readAgentRegistry,
  registerAgentConnector,
  releaseSpawnLease,
  SpawnError,
  stepParent,
  withAgentRegistryLock,
} from './core.ts';
import type {
  AgentConnector,
  AgentInfo,
  AgentRegistryEntry,
  ConnectorCtx,
  SpawnSpec,
} from './types.ts';

type HerdrResult = { result?: Record<string, unknown> };

function herdrCall(args: string[], cwd?: string): Record<string, unknown> {
  const bin = process.env.HERDR_BIN_PATH ?? 'herdr';
  const result = spawnSync(bin, args, {
    cwd,
    encoding: 'utf8',
    timeout: 180_000,
    env: process.env,
  });
  if (result.status !== 0) {
    throw new SpawnError(
      `herdr ${args.slice(0, 2).join(' ')} failed — ${result.stderr?.trim() || result.error?.message || result.status}`,
      'unavailable'
    );
  }
  try {
    const parsed = JSON.parse(result.stdout ?? '') as HerdrResult;
    return parsed.result ?? {};
  } catch {
    throw new SpawnError(
      `herdr ${args.slice(0, 2).join(' ')} returned invalid JSON`,
      'unavailable'
    );
  }
}

function workId(input: { value: string }): string {
  const { value } = input;
  const safe = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/_/g, '-');
  const suffix = createHash('sha256').update(value).digest('hex').slice(0, 8);
  return `${safe.slice(0, 22) || 'bro-worker'}-${suffix}`;
}

function agentInfo(input: { step: string; entry: AgentRegistryEntry }): AgentInfo {
  const { step, entry } = input;
  return {
    id: entry.agentId,
    molStep: step,
    backend: entry.backend,
    state: entry.stopped === true ? 'stopped' : 'running',
    spawnedAt: entry.spawnedAt,
    runId: entry.runId,
    provider: entry.provider,
    model: entry.model,
    worktree: typeof entry.worktree === 'string' ? entry.worktree : undefined,
    log: typeof entry.log === 'string' ? entry.log : undefined,
  };
}

function workspaceId(result: Record<string, unknown>): string {
  const direct = result.workspace_id;
  if (typeof direct === 'string' && direct !== '') return direct;
  const nested = result.workspace;
  if (typeof nested === 'object' && nested !== null) {
    const id = (nested as { workspace_id?: unknown }).workspace_id;
    if (typeof id === 'string' && id !== '') return id;
  }
  throw new SpawnError('herdr worktree open returned no workspace id', 'unavailable');
}

function paneId(result: Record<string, unknown>): string {
  const panes = result.panes;
  if (Array.isArray(panes)) {
    const first = panes[0];
    if (typeof first === 'object' && first !== null) {
      const id = (first as { pane_id?: unknown }).pane_id;
      if (typeof id === 'string' && id !== '') return id;
    }
  }
  throw new SpawnError('herdr workspace has no pane', 'unavailable');
}

interface HerdrOpenInput {
  spec: SpawnSpec;
  main: string;
  parentWorkspace: string | undefined;
  kind: string;
}

function openHerdrAgent(input: HerdrOpenInput): void {
  const { spec, main, parentWorkspace, kind } = input;
  const opened = herdrCall(
    [
      'worktree',
      'open',
      ...(parentWorkspace === undefined
        ? ['--cwd', resolve(main)]
        : ['--workspace', parentWorkspace]),
      '--path',
      resolve(spec.repoRoot),
      '--no-focus',
    ],
    spec.repoRoot
  );
  const ws = workspaceId(opened);
  const pane = paneId(herdrCall(['pane', 'list', '--workspace', ws], spec.repoRoot));
  const name = workId({ value: spec.molStep });
  herdrCall(['agent', 'start', name, '--kind', kind, '--pane', pane], spec.repoRoot);
  herdrCall(['agent', 'prompt', name, spec.prompt], spec.repoRoot);
}

interface HerdrCommitInput {
  dir: string;
  home: string;
  spec: SpawnSpec;
  prepared: ReturnType<typeof prepareSpawn>;
  existing: AgentRegistryEntry | undefined;
}

function commitHerdrAgent(input: HerdrCommitInput): AgentInfo {
  const { dir, home, spec, prepared, existing } = input;
  commitSpawn(
    dir,
    home,
    'herdr',
    spec,
    {},
    {
      agentId: prepared.agentId,
      claimed: existing !== undefined,
      actor: existing === undefined ? undefined : bdActor(spec.beadsDir),
      phantom: existing === undefined && spec.molStep.startsWith('adhoc-'),
      previousAssignee: undefined,
      existing,
      lease: prepared.lease,
      runId: prepared.runId,
    }
  );
  const entry = readAgentRegistry(dir)[spec.molStep];
  if (entry === undefined) {
    throw new SpawnError(`herdr agent ${spec.molStep} was not registered`, 'unavailable');
  }
  return agentInfo({ step: spec.molStep, entry });
}

export function makeHerdrConnector(ctx: ConnectorCtx, env: AgentConnectorEnv): AgentConnector {
  const dir = ctx.dir;
  const knobs = env.agents.herdr ?? {};
  const kind = typeof knobs.kind === 'string' && knobs.kind !== '' ? knobs.kind : 'devin';
  const parentWorkspace = typeof knobs.workspace === 'string' ? knobs.workspace : undefined;
  const main = dirname(dir);
  const find = (id: string) => findAgentEntry(dir, 'herdr', id);

  return {
    name: 'herdr',

    async spawn(spec: SpawnSpec): Promise<AgentInfo> {
      assertMutableConfig(dir);
      const home = agentsHome(dir);
      if (home === null) throw new SpawnError('herdr requires a git worktree', 'config');
      const mol = stepParent(spec.beadsDir, spec.molStep);
      if (mol === undefined) throw new SpawnError(`cannot resolve ${spec.molStep}`, 'input');
      return withAgentRegistryLock(dir, () => {
        const prepared = prepareSpawn(dir, home, 'herdr', spec, {
          isLive: entry => entry.stopped !== true,
          liveDetail: entry => `herdr agent ${entry.agentId}`,
          cap: { max: fleetCapOf(env), env },
          env,
          external: externalGuardOf(env),
        });
        try {
          openHerdrAgent({ spec, main, parentWorkspace, kind });
          const existing = readAgentRegistry(dir)[spec.molStep];
          return commitHerdrAgent({ dir, home, spec, prepared, existing });
        } catch (error) {
          releaseSpawnLease(dir, prepared.lease);
          throw error;
        }
      });
    },

    async list() {
      try {
        return {
          agents: Object.entries(readAgentRegistry(dir))
            .filter(([, entry]) => entry.backend === 'herdr')
            .map(([step, entry]) => agentInfo({ step, entry })),
        };
      } catch (error) {
        return { agents: [], degraded: error instanceof Error ? error.message : String(error) };
      }
    },

    async status(id: string) {
      const hit = find(id);
      if (hit === undefined) throw new AgentNotFound(`no herdr agent ${id}`);
      return agentInfo({ step: hit[0], entry: hit[1] });
    },

    async stop(id: string) {
      const hit = find(id);
      if (hit === undefined) return;
      try {
        herdrCall(['agent', 'stop', workId({ value: hit[0] })], dir);
      } finally {
        markStoppedEntry({ dir, molStep: hit[0], entry: hit[1], id, stillLive: () => false });
      }
    },

    capabilities: () => ({ attach: true, respawn: true, supervisor: 'none' }),
  };
}

registerAgentConnector('herdr', makeHerdrConnector, {}, { builtin: true });
