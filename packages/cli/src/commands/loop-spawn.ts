import { spawn } from 'node:child_process';
import { closeSync } from 'node:fs';
import { dirname } from 'node:path';
import { procStat, type SpawnWorker } from '@broject/core';
import { type LoopLane } from '@broject/rig';
import { loopSlug } from '@broject/loop';
import { type Ctx, agentEnv, laneCommand, provenancePins, say } from './loop.ts';
import { beginLoopRun, loopRunLog } from './loop-state.ts';
import { expandAgentCmd } from '@broject/loop';
import { otelHeader, otelSpan } from '@broject/providers';
import { mkdirPrivateSync, openPrivateAppendSync } from '@broject/core';
import { worktreeTelemetryDims } from '../agent-connectors.ts';

/** Does this process GROUP still hold a live member? `detached: true`
 *  makes a spawn's leader pid its group id — the group lives while any
 *  descendant runs (a template's `worker >log 2>&1 &` survives the `sh
 *  -c` leader's own exit). EPERM answers "yes" — the group exists but
 *  refuses our signal; ESRCH is gone. */
export function processGroupLive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Fresh sibling worktree on loop/<id> off origin/main (falls back to
 *  main/HEAD when no origin) — or off `base` when a stack already picked
 *  the fork point. An existing dir is reused as-is. */
export function spawnAgent(
  ctx: Ctx,
  lane: LoopLane,
  beadIds: string[],
  title: string,
  promptFile: string,
  dir: string,
  agentId?: string
): Promise<number | null> {
  return new Promise(resolve => {
    const leadId = beadIds[0]!;
    // agent.spawn span + TRACEPARENT — the same child-trace injection
    // spawnStepAgent performs at the `bro fleet agents up` site (spec
    // bro-xgejl.1); without it the worker's own spans root a fresh
    // trace instead of nesting under this spawn
    const dims = worktreeTelemetryDims(dir);
    const span = otelSpan('agent.spawn', {
      'agent.step': leadId,
      'agent.backend': 'template',
      'agent.provider': lane.provider ?? '',
      'agent.model': lane.model ?? '',
      'agent.worktree': dims.worktree,
      ...(dims.branch === undefined ? {} : { 'agent.branch': dims.branch }),
      ...(dims.repo === undefined ? {} : { 'agent.repo': dims.repo }),
    });
    const tp = otelHeader(span.ctx);
    const ep = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const env = agentEnv(ctx, {
      // BRO_BEAD_ID stays the lead for compatibility — batch work orders
      // read the whole clump off BRO_BEAD_IDS
      BRO_BEAD_ID: leadId,
      BRO_BEAD_IDS: beadIds.join(','),
      BRO_BEAD_TITLE: title,
      BRO_PROMPT_FILE: promptFile,
      // the template arm's session/agent ids are the run key — the
      // connector's agentId-fallback semantics (spec bro-xgejl.1)
      ...(agentId !== undefined ? { BRO_AGENT_ID: agentId, BRO_SESSION_ID: agentId } : {}),
      // telemetry dims (spec bro-xgejl.1) — ambient copies are stripped
      // in agentEnv; these are THIS worktree's, never the parent's
      BRO_WORKTREE: dims.worktree,
      ...(dims.branch === undefined ? {} : { BRO_BRANCH: dims.branch }),
      ...(dims.repo === undefined ? {} : { BRO_REPO: dims.repo }),
      TRACEPARENT: tp,
      ...(ep !== undefined && ep !== '' ? { OTEL_EXPORTER_OTLP_ENDPOINT: ep } : {}),
      ...provenancePins(ctx, leadId, lane),
      ...(lane.class === undefined ? {} : { BRO_AGENT_CLASS: lane.class }),
      // the fleet.matrix lane the enforce pick resolved to — same
      // provenance pin the registry path stamps via spec.matrix
      // (spec bro-v0pvd.1.1); absent on shadow/off/unrouted lanes
      ...(lane.matrix === undefined ? {} : { BRO_AGENT_MATRIX: lane.matrix }),
    });
    const slug = loopSlug(leadId);
    const log = loopRunLog(ctx.root, slug);
    let logFd: number | null = null;
    if (log !== null) {
      try {
        mkdirPrivateSync(dirname(log));
        logFd = openPrivateAppendSync(log);
      } catch {
        logFd = null;
      }
    }
    const opts = {
      cwd: dir,
      env,
      stdio:
        logFd !== null
          ? (['inherit', logFd, logFd] as Array<'inherit' | number>)
          : (['inherit', ctx.json ? 2 : 'inherit', 'inherit'] as Array<'inherit' | number>),
      detached: true,
    };
    const w = lane.worker;
    // When a log file is open, prefix every emitted line with an ISO8601
    // timestamp so loop.out/daemon.log-style trails stay attributable
    // (spec bro-7h976). The wrapped command's exit status is captured to
    // a side file before the filter runs, so the pipeline reports the
    // AGENT's code, never the while loop's 0.
    // single-quote escaping, not JSON.stringify: inside the sh -c
    // wrapper a double-quoted assignment still expands $ ` $() and
    // backslashes before eval ever sees the command (kody #760)
    const sqEsc = String.raw`'\''`;
    const shq = (s: string): string => `'${s.replaceAll("'", sqEsc)}'`;
    const wrap = (cmd: string): string =>
      `({ _bro_cmd=${shq(cmd)}; _bro_rcf=$(mktemp); { (eval "$_bro_cmd"; echo $? > "$_bro_rcf") 2>&1 | while IFS= read -r _l || [ -n "$_l" ]; do printf '[%s] %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$_l"; done; }; _bro_rc=$(cat "$_bro_rcf" 2>/dev/null || echo 1); rm -f "$_bro_rcf"; exit "$_bro_rc"; })`;
    const child =
      w?.kind === 'argv'
        ? // the same `"$@"` positional exec the native backend builds —
          // argv workers are headless by construction (acp); sh resolves
          // argv[0] ('bro'/'npx') on PATH the way the backend does
          logFd !== null
          ? spawn('sh', ['-c', wrap('"$@"'), 'loop-agent', ...w.argv, promptFile], opts) // NOSONAR — argv[0] resolves on PATH by design, same as the backend's spawn
          : spawn('sh', ['-c', 'exec "$@"', 'loop-agent', ...w.argv, promptFile], opts) // NOSONAR — argv[0] resolves on PATH by design, same as the backend's spawn
        : logFd !== null
          ? spawn('sh', ['-c', wrap(expandAgentCmd(laneCommand(ctx, lane)))], opts) // NOSONAR — operator-configured agent command
          : spawn('sh', ['-c', expandAgentCmd(laneCommand(ctx, lane))], opts); // NOSONAR — operator-configured agent command
    if (logFd !== null) {
      // the child holds its own dup — our copy is spent
      closeSync(logFd);
    }
    if (child.pid !== undefined) {
      beginLoopRun(ctx.root, {
        beadId: leadId,
        beadIds,
        slug,
        pid: child.pid,
        pidStart: procStat(child.pid)?.start,
        startedAt: new Date().toISOString(),
        worktree: dir,
        log: log ?? '',
      });
      const logNote = log === null ? '' : ` — log ${log}`;
      say(ctx, `loop: agent ${beadIds.join(', ')} on pid ${child.pid}${logNote}`);
    }
    ctx.stage = `worker pid=${child.pid ?? '?'}`;
    // The run is over when the spawn's PROCESS GROUP empties, not when
    // the `sh -c` leader exits — `detached: true` makes the leader's
    // pid the group id, and a template that backgrounds its worker
    // (`worker >log 2>&1 &`) frees the leader while the worker still
    // runs. Resolving earlier would release the admission's claims
    // while work still stands — the provider cap's ledger would seat
    // a second start over a live one (coderabbit PR #1094). A worker
    // that double-forks out of the group escapes this watch by
    // construction — nothing left names it.
    const groupLive = (): boolean => child.pid !== undefined && processGroupLive(child.pid);
    const settle = (code: number | null): void => {
      // custody returns to the loop process — the worker is gone but the
      // claim isn't: findPr and the member's watchBegin still stand
      // between here and a verdict (bro-ho09d: endLoopRun here left a
      // window where a racing sweep saw a dead owner and released a
      // still-settling claim)
      beginLoopRun(ctx.root, {
        beadId: leadId,
        beadIds,
        slug,
        pid: process.pid,
        pidStart: procStat(process.pid)?.start,
        startedAt: new Date().toISOString(),
        worktree: dir,
        log: log ?? '',
      });
      // the span covers the whole run — spawn failure is the only
      // error verdict; a completed run reports its exit code (spec
      // bro-xgejl.1)
      span.end(
        code === null ? { error: 'agent spawn failed' } : { 'agent.exit_code': code },
        code === null ? 'error' : 'ok'
      );
      resolve(code);
    };
    child.on('error', err => {
      console.error(`loop: agent spawn failed — ${err.message}`);
      settle(null);
    });
    child.on('exit', (code, signal) => {
      if (code === null) {
        console.error(`loop: agent died on signal ${signal ?? '?'}`);
      }
      // the leader is gone — the verdict lands when the GROUP is empty:
      // a detached worker still running holds the claims it was
      // admitted under
      const drain = (): void => {
        if (!groupLive()) {
          settle(code);
          return;
        }
        const timer = setTimeout(drain, 1000);
        timer.unref();
      };
      drain();
    });
  });
}
