/** `bro loop`'s argv layer — the usage text, the strict flag whitelist
 *  a template `--agent` makes load-bearing, and the lane-pick flags
 *  every resolution path reads. Split out of loop.ts — the module was
 *  already over the CodeScene file-size bar and the wave-2 extractions
 *  pushed it past the single-module function count too. */
import { type ExitCode, printUsage } from '@broject/core';
import type { LoopConfig } from '@broject/loop';
import type { LoopLane } from '@broject/rig';
import { isStackName } from '@broject/stack';
import { type AgentConnectorEnv, fleetProfileOf } from '../agent-connectors.ts';
import { flag, positionals } from './args.ts';
import { MIN_INTERVAL_SEC } from './drive-config.ts';

/** What a spawn runs — the provider-resolved worker when the provider
 *  lane engaged, undefined for the raw `loop.agent`/`--agent` template. */
export interface LoopLaneSel {
  agent?: string;
  provider?: string;
  profile?: string;
  model?: string;
  autoApprove?: boolean;
  class?: string;
}

export function usage(exitCode: ExitCode = 2): never {
  printUsage(
    `Usage: bro loop [--max N] [--dry-run] [--json] [--label a,b] [--stack NAME]
       bro loop [--every SEC]        run in supervised loop mode
       bro loop install [--every N] [--print]
       bro loop uninstall
  --agent '<cmd {promptFile}>'   agent template (config: loop.agent) —
                                a value naming a configured providers.<name>
                                spawns through the provider registry instead
  --provider NAME                providers.<name> pick (acp → headless worker)
  --profile NAME                 fleet.profiles.<name> preset
  --class NAME                   pin every claimed bead to one
                                fleet.routing class (default: the bead's
                                class:<name> label, else 'default')
  --model M                      model override for the provider lane
  --auto-approve                 acp permission policy: allow, not deny
  --explain[=SLICES]             print why the bead landed on this route —
                                route, model, health, cost (or a subset)
  --merge-timeout MIN            gate budget per round (loop.mergeTimeoutMin, 45)
  --parked-wake MIN              parked bead's snooze before it wakes to
                                open (loop.parkedWakeMin, 120; 0 = iced
                                until bd undefer)
  --label a,b                    declared scope — only beads carrying one
                                of these labels are claimable
  --stack NAME                   chain claimed beads onto stack NAME —
                                each PR targets the member below
  --max-open N                   cap the gate stack's open PRs (loop.maxOpen, 1)
  --max-open-total N             hard ceiling on total open fleet PRs (loop.maxOpenTotal, 10; 0 = off)
  --disk-min-slots N             disk floor in slot units — pushes hold while
                                free disk < N×loop.worktreeMb on any fs the
                                run writes to (loop.diskMinSlots, 2; 0 = off)
  --batch N                      max beads per claim — a clump shares the
                                lead's affinity key (spec/epic/area/path),
                                one worktree, one worker, one PR
                                (loop.batch, 1 = solo)
  --every SEC                    supervised loop cadence, ≥${MIN_INTERVAL_SEC}s
  --interval SEC                 gate poll interval, ≥0.1s (60)`,
    exitCode
  );
}

export function labelSelection(argv: string[]): { labels?: string[] } {
  const raw = flag(argv, '--label');
  if (raw === undefined) {
    return {};
  }
  const labels = raw
    .split(',')
    .map(s => s.trim())
    .filter(s => s !== '');
  if (labels.length === 0) {
    console.error('error: --label requires a comma-separated value, e.g. --label debt,ui');
    process.exit(2);
  }
  return { labels };
}

/** `--stack NAME` — must form a git-ref-safe component or the member
 *  branches it plans would fail on creation mid-run. */
export function stackNameFlag(argv: string[]): string | undefined {
  const name = flag(argv, '--stack');
  if (name !== undefined && !isStackName(name)) {
    console.error(`bro loop: invalid stack name "${name}" ([a-z0-9_.-])`);
    process.exit(2);
  }
  return name;
}

const LOOP_VALUE_FLAGS = new Set([
  '--agent',
  '--merge-timeout',
  '--parked-wake',
  '--max',
  '--max-open',
  '--max-open-total',
  '--worktree-warn',
  '--disk-min-slots',
  '--batch',
  '--batch-min-priority',
  '--interval',
  '--every',
  '--label',
  '--stack',
  '--provider',
  '--profile',
  '--class',
  '--model',
]);
const LOOP_BOOL_FLAGS = new Set([
  '--json',
  '--dry-run',
  '--help',
  '--auto-approve',
  '--print',
  '--explain',
]);

/** Strict flag parse — an unquoted `--agent devin -p --prompt-file
 *  {promptFile}` reads as agent='devin' plus a tail of unknown flags,
 *  silently spawning a bare `devin <file>` TUI per bead instead of a
 *  headless worker. */
export function rejectStrayArgs(argv: string[]): void {
  const stray = positionals(argv, LOOP_VALUE_FLAGS, {
    boolFlags: LOOP_BOOL_FLAGS,
    strict: true,
  });
  if (stray.length > 0) {
    console.error(
      `bro loop: unexpected argument '${stray[0]}' — quote the agent template ` +
        "as one arg: --agent 'devin -p --prompt-file {promptFile}'"
    );
    process.exit(2);
  }
}

export function loopLaneSel(argv: string[]): LoopLaneSel {
  return {
    agent: flag(argv, '--agent'),
    provider: flag(argv, '--provider'),
    profile: flag(argv, '--profile'),
    model: flag(argv, '--model'),
    autoApprove: argv.includes('--auto-approve') ? true : undefined,
    class: flag(argv, '--class'),
  };
}

/** The flag TIER's provider pick — with routing armed, lane.provider
 *  also carries the fallback class's chain head (the floor), so
 *  "is the provider pinned?" must be read from the picks themselves. */
export function flagTierPin(env: AgentConnectorEnv, sel: LoopLaneSel): boolean {
  return (
    sel.provider !== undefined ||
    (sel.agent !== undefined && Object.hasOwn(env.providers ?? {}, sel.agent)) ||
    (sel.profile !== undefined && fleetProfileOf(env, sel.profile).provider !== undefined)
  );
}

/** The template the run expands — a cli provider's `command`
 *  substitutes for `loop.agent`; a template --agent stays the literal
 *  value (provider names are never templates, resolveLoopLane consumed
 *  them); else the config default. */
export function effectiveAgent(
  lane: LoopLane,
  sel: LoopLaneSel,
  env: AgentConnectorEnv,
  cfg: LoopConfig
): string {
  if (lane.worker?.kind === 'template') {
    return lane.worker.command;
  }
  const agentFlag = sel.agent;
  if (agentFlag !== undefined && !Object.hasOwn(env.providers ?? {}, agentFlag)) {
    return agentFlag;
  }
  return cfg.agent;
}
