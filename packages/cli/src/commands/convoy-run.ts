/**
 * `bro convoy run` — the command adapter over `convoyPolicy` in
 * `@broject/rig` (bro-u6fp5): argv parsing, deps wiring, verdict
 * render, and exit code live here; the molecule FSM (select →
 * spawn → poll → classify → retry/wait/park) lives in the policy.
 *
 *   bro convoy run <mol>…             each molecule to 'complete', one at a time
 *   bro convoy run --open             every open molecule, pour order
 *   bro convoy run --attempts N       per-mol attempt cap (4)
 *   bro convoy run --poll SEC         agent state poll interval (15)
 *   bro convoy run --retry-delay SEC  spacing between crash retries (60)
 *   bro convoy run --json             one JSON verdict line per mol
 *
 * Sequential like the script it replaces — the inference-budget wall is
 * why this epic exists; fleet.maxConcurrent still bounds the fleet at
 * the spawn prologue. Each mol spawns a convoy-runner agent through the
 * facade keyed on the molecule ROOT bead — the registry pins
 * {pid, log, prompt, exit} so `bro agents status`/`bro fleet`/`bro
 * watch` see the worker the script used to hide, and the exit-cause
 * taxonomy decides what a death means: rate_limited waits for the
 * provider's reset, stopped is an operator verdict (never respawned),
 * crashes retry bounded by --attempts.
 */
import {
  agentRegistryPath,
  facade,
  loadConfig,
  readAgentRegistry,
  type AgentConnector,
} from '@broject/core';
import { beadsDir, listMolecules, loadMolecule, nextStep } from '@broject/convoy';
import { runQueue, type RunArgs, type RunDeps } from '@broject/rig';
import {
  fleetCapOf,
  fleetOccupancyFor,
  loadAgentEnv,
  resolveAgentConnector,
  type AgentConnectorEnv,
} from '../agent-connectors.ts';
import { flag, positionals } from './args.ts';
import { LEARN_RETRO_CLOSEOUT } from '@broject/loop';
import { spawnStepAgent, type StepSpawnRequest } from './agents.ts';
import { registryEntryState } from './drive.ts';
import { mainWorktree } from './work.ts';
import { dirname, join } from 'node:path';

// --- args ------------------------------------------------------------------------

const RUN_VALUE_FLAGS: ReadonlySet<string> = new Set(['--attempts', '--poll', '--retry-delay']);

const numFlag = (argv: string[], name: string, dflt: number): number => {
  const raw = flag(argv, name);
  if (raw === undefined) {
    return dflt;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    console.error(`error: ${name} needs a value >= 1, got "${raw}"`);
    process.exit(2);
  }
  return n;
};

export function runArgs(argv: string[]): RunArgs {
  return {
    mols: positionals(argv, RUN_VALUE_FLAGS),
    open: argv.includes('--open'),
    attempts: numFlag(argv, '--attempts', 4),
    pollSec: numFlag(argv, '--poll', 15),
    retryDelaySec: numFlag(argv, '--retry-delay', 60),
    json: argv.includes('--json'),
  };
}

/** The flags `run` understands — the dispatcher's unknown-option check
 *  reads this so a misspelled flag can't silently degrade a run. */
export const RUN_KNOWN_FLAGS: ReadonlySet<string> = new Set([
  ...RUN_VALUE_FLAGS,
  '--open',
  '--json',
]);

// --- prompt ------------------------------------------------------------------------

/** The convoy-runner work order — mol-queue2.sh's prompt verbatim in
 *  spirit: work the molecule's steps in order to 'complete', merge is
 *  the worker's, dead-session claims get released and re-claimed. */
export function runnerPrompt(molId: string, repo: string): string {
  return [
    `Run the convoy for molecule ${molId}. Use the convoy skill (skills/convoy/SKILL.md):`,
    `\`bro convoy next --mol ${molId}\`, claim steps, work them in order — including`,
    'Verify and Merge steps (merge is yours: `bro act merge` refuses on a non-green',
    'gate, keep fixing/deferring until it merges). If a step is already claimed by a',
    'dead session, release it (`bd update <step> --status open`) and claim it yourself.',
    `Work in ${repo} — create your worktree via the work skill. If the bead references`,
    "a spec, read it from specs/ first. Run the molecule to 'state: complete' — do NOT",
    'stop at gates you can settle yourself; a real human gate means exit cleanly and',
    'let the runner report the mol gated.',
    '',
    LEARN_RETRO_CLOSEOUT,
  ].join('\n');
}

/** The runner's spawn request — mol-queue work is fleet-owned, so the
 *  worker rides the batch lane: BRO_BATCH marks it for the provider
 *  wall (spec bro-1x7p) and the fleet's own caps; an unmarked runner
 *  would spawn into a rate_limited wall and burn a doomed session
 *  (drill bro-gblja). Identity pins still win over this env — the
 *  marker is the only thing a caller owns here. */
export function runnerSpawnReq(molId: string, dir: string, beads: string): StepSpawnRequest {
  return {
    lane: 'batch',
    molStep: molId,
    worktree: dir,
    prompt: runnerPrompt(molId, dir),
    beadsDir: beads,
  };
}

// --- settle events ------------------------------------------------------------------

/** The HUMAN GATE moment — a mol that reached a human step exists
 *  precisely so a person hears about it. Publishes through the events
 *  facade so `notify.sinks` webhooks see it (spec: specs/bro-huy5o.8.md);
 *  the keyed event also coalesces repeat sightings on the mailbox.
 *  Fail-open like every emit — a gate report never stalls the runner. */
export async function publishGate(dir: string, molId: string, detail: string): Promise<void> {
  return publishConvoyEvent('gate', dir, molId, detail);
}

type ConvoyPublishKind = 'gate' | 'parked' | 'stopped' | 'failed';

const PUBLISH_LABELS: Record<ConvoyPublishKind, string> = {
  gate: 'HUMAN GATE ready',
  parked: 'parked',
  stopped: 'stopped',
  failed: 'failed',
};

const PUBLISH_KEY_PREFIX: Record<ConvoyPublishKind, string> = {
  gate: 'convoy-gate-',
  parked: 'convoy-parked-',
  stopped: 'convoy-stopped-',
  failed: 'convoy-failed-',
};

async function publishConvoyEvent(
  kind: ConvoyPublishKind,
  dir: string,
  molId: string,
  detail: string
): Promise<void> {
  try {
    const label = PUBLISH_LABELS[kind];
    const payload =
      kind === 'gate'
        ? `convoy ${molId}: ${label}` +
          (detail === '' ? '' : ` — ${detail}`) +
          ' — human input needed'
        : `convoy ${molId}: ${label}` + (detail === '' ? '' : ` — ${detail}`);
    await facade('events', { dir }, { prefer: loadConfig(dir).connectors }).publish({
      topic: 'convoy',
      kind,
      key: `${PUBLISH_KEY_PREFIX[kind]}${molId}`,
      source: 'convoy',
      payload,
    });
  } catch {
    // fail-open — sinks/mailbox are advisory edges, never a runner failure
  }
}

/** A mol parked on a budget wall with no advertised end (quota / no-reset
 *  rate limit) — notify the operator so they can act. Fail-open like every
 *  emit. */
export async function publishParked(dir: string, molId: string, detail: string): Promise<void> {
  return publishConvoyEvent('parked', dir, molId, detail);
}

/** An operator-stopped mol — report it so a detached queue doesn't go
 *  blind. Fail-open like every emit. */
export async function publishStopped(dir: string, molId: string, detail: string): Promise<void> {
  return publishConvoyEvent('stopped', dir, molId, detail);
}

/** Attempts exhausted for a mol — report it so a detached queue doesn't go
 *  blind. Fail-open like every emit. */
export async function publishFailed(dir: string, molId: string, detail: string): Promise<void> {
  return publishConvoyEvent('failed', dir, molId, detail);
}

// --- the command ------------------------------------------------------------------------

const sleepWall = (sec: number): Promise<void> => new Promise(r => setTimeout(r, sec * 1000));

/** Registry-only entry reads for the refusal classifier — home is the
 *  agents dir beside agents.json (same derivation drive's
 *  registryAgents uses). */
function entryOps(dir: string): Pick<RunDeps, 'entry' | 'entryState'> {
  const regPath = agentRegistryPath(dir);
  const home = regPath === null ? null : join(dirname(regPath), 'agents');
  return {
    entry: molId => (regPath === null ? undefined : readAgentRegistry(dir)[molId]),
    entryState: e => registryEntryState(home, e),
  };
}

export async function runConvoyRun(argv: string[]): Promise<void> {
  const cfg = runArgs(argv);
  const ids = cfg.mols.length + (cfg.open ? 1 : 0);
  if (ids === 0) {
    console.error('error: run needs molecule ids or --open');
    process.exit(2);
  }
  const main = mainWorktree();
  const dir = main.path;
  const env: AgentConnectorEnv = loadAgentEnv(dir);
  const conn: AgentConnector = resolveAgentConnector({ dir }, {}, env);
  const beads = beadsDir();

  const say = (msg: string): void => {
    if (cfg.json) {
      console.error(msg);
    } else {
      console.log(msg);
    }
  };
  const deps: RunDeps = {
    loadMol: loadMolecule,
    next: nextStep,
    listOpen: listMolecules,
    spawn: molId => spawnStepAgent(dir, env, runnerSpawnReq(molId, dir, beads)),
    status: id => conn.status(id),
    ...entryOps(dir),
    fleetFull: () => {
      const cap = fleetCapOf(env);
      return cap > 0 && fleetOccupancyFor(dir, env) >= cap;
    },
    sleepSec: sleepWall,
    now: () => Date.now(),
    say,
    onGated: r => publishGate(dir, r.mol, r.detail ?? ''),
    onParked: r => publishParked(dir, r.mol, r.detail ?? ''),
    onStopped: r => publishStopped(dir, r.mol, r.detail ?? ''),
    onFailed: r => publishFailed(dir, r.mol, r.detail ?? ''),
  };

  const results = await runQueue(deps, cfg);
  let failed = 0;
  for (const r of results) {
    if (cfg.json) {
      console.log(JSON.stringify(r));
    } else {
      const detail = r.detail === undefined ? '' : ` — ${r.detail}`;
      console.log(`run ${r.mol} ${r.verdict}${detail}`);
    }
    if (r.verdict === 'failed' || r.verdict === 'error' || r.verdict === 'blocked') {
      failed += 1;
    }
  }
  const stopped = results.some(r => r.queueStop === true);
  say(
    `run: queue ${stopped ? 'stopped' : 'drained'} — ` +
      `${results.length - failed}/${results.length} settled`
  );
  if (failed > 0) {
    process.exitCode = 1;
  }
}
