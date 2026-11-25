/** Dead-loop gate — session-scoped repetition detection over the
 *  trace journal (`trace/<session>.jsonl`, written by journalTrace).
 *
 *  An agent stuck re-issuing the identical tool call is the classic
 *  silent failure: every call "succeeds", nothing progresses, and the
 *  turn burns budget forever. Hosts may or may not detect this
 *  natively — bro's hook layer guarantees it everywhere `bro hooks`
 *  runs, because the signal lives in the journal every post-tool
 *  already appends to.
 *
 *  Two-stage contract, gates-not-loops like the rest of the hook
 *  plane:
 *    1. post-tool — a trailing run of DEAD_LOOP_REPEAT identical
 *       signatures writes `trace/<session>.deadloop.json` and adds a
 *       warning line to the hook context (advisory, never blocks).
 *    2. pre-tool  — while the marker is fresh, a call whose signature
 *       matches the looped one is vetoed (`decision: block` /
 *       codex `permissionDecision: deny`) with a reason that names
 *       the repeat count. A DIFFERENT call passes untouched — the
 *       gate only closes on the loop itself.
 *
 *  The marker expires (DEAD_LOOP_TTL_MS) so a session that changed
 *  approach and wandered back later gets a fresh detection cycle
 *  instead of a permanent ban. Observe mode never reaches either
 *  stage — detection is active behavior, and passive telemetry
 *  (journalTrace) still records everything. */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { GIT_SYNC_PROBE_TIMEOUT_MS, gitCommonDir } from '@broject/core';

/** `<git-common>/bro/hooks` — the same state root hooks.ts resolves
 *  (worktree-shared markers); duplicated here rather than imported so
 *  this module stays a leaf — hooks.ts pulls it in, never the reverse. */
function hooksStateDir(dir: string): string | null {
  const gd = gitCommonDir(dir, GIT_SYNC_PROBE_TIMEOUT_MS);
  return gd !== null ? join(gd, 'bro', 'hooks') : null;
}

/** Consecutive identical signatures that arm the gate. Four is past
 *  coincidence (retry-once, verify-twice) and well under the dozens a
 *  real wedge burns. */
export const DEAD_LOOP_REPEAT = 4;
/** How far back the trailing run may look — the journal keeps 500
 *  lines but a loop older than this window is stale context, not a
 *  live wedge. */
const SCAN_TAIL = 50;
/** Marker freshness — an agent that changed approach gets this long
 *  before the same signature is looped again from scratch. */
export const DEAD_LOOP_TTL_MS = 15 * 60_000;

interface TraceEntry {
  ts?: number;
  tool?: string;
  command?: string;
  paths?: string[];
  ok?: boolean;
}

interface DeadLoopMarker {
  signature: string;
  count: number;
  ts: number;
}

/** The identity of "the same call again": tool plus its distinguishing
 *  payload — `command` for exec-family, sorted `paths` for
 *  edit/write, a stable stringify of tool_input for everything else.
 *  Whitespace collapses so `cmd  -x` and `cmd -x` are one signature. */
export function deadSignature(input: { tool_name?: unknown; tool_input?: unknown }): string {
  const tool = typeof input.tool_name === 'string' ? input.tool_name : '';
  const ti = (input.tool_input ?? {}) as Record<string, unknown>;
  return `${tool}|${detailOf(ti)}`.slice(0, 400);
}

function detailOf(ti: Record<string, unknown>): string {
  if (typeof ti.command === 'string' && ti.command !== '') {
    return ti.command.replace(/\s+/g, ' ').trim();
  }
  if (Array.isArray(ti.paths) && ti.paths.length > 0) {
    return [...ti.paths].sort((a, b) => a.localeCompare(b)).join(',');
  }
  const fp =
    typeof ti.file_path === 'string' ? ti.file_path : typeof ti.path === 'string' ? ti.path : '';
  return fp !== '' ? fp : stableStringify(ti);
}

function stableStringify(v: unknown): string {
  try {
    return JSON.stringify(
      v,
      Object.keys(v as object).sort((a, b) => a.localeCompare(b))
    );
  } catch {
    return String(v);
  }
}

interface DeadTarget {
  dir: string;
  sessionId: string;
}

function tracePath(t: DeadTarget): string | null {
  const stateDir = hooksStateDir(t.dir);
  const safe = t.sessionId.replace(/[^\w.-]/g, '_');
  return stateDir && safe ? join(stateDir, 'trace', `${safe}.jsonl`) : null;
}

function markerPath(t: DeadTarget): string | null {
  const tp = tracePath(t);
  return tp === null ? null : tp.replace(/\.jsonl$/, '.deadloop.json');
}

/** Trailing run of identical signatures at the journal tail, counted
 *  from the LAST entry backwards. Returns the signature and run
 *  length, or null under the threshold / on any read failure —
 *  detection is advisory, a torn journal means no opinion. */
export function trailingLoop(
  t: DeadTarget,
  threshold = DEAD_LOOP_REPEAT
): { signature: string; count: number; failing: boolean } | null {
  const path = tracePath(t);
  if (path === null || !existsSync(path)) {
    return null;
  }
  let lines: string[];
  try {
    lines = readFileSync(path, 'utf8')
      .split('\n')
      .filter(l => l !== '');
  } catch {
    return null;
  }
  return countTailRun(lines.slice(-SCAN_TAIL), threshold);
}

function countTailRun(
  tail: string[],
  threshold: number
): { signature: string; count: number; failing: boolean } | null {
  let sig: string | null = null;
  let count = 0;
  let failing = false;
  for (let i = tail.length - 1; i >= 0; i--) {
    let entry: TraceEntry;
    try {
      entry = JSON.parse(tail[i] as string) as TraceEntry;
    } catch {
      break;
    }
    const s = signatureOfEntry(entry);
    if (s === '') {
      break;
    }
    if (sig === null) {
      sig = s;
      failing = entry.ok === false;
    } else if (s !== sig) {
      break;
    }
    count++;
  }
  if (sig === null || count < threshold) {
    return null;
  }
  return { signature: sig, count, failing };
}

function signatureOfEntry(e: TraceEntry): string {
  const tool = typeof e.tool === 'string' ? e.tool : '';
  if (tool === '') {
    return '';
  }
  const detail =
    typeof e.command === 'string' && e.command !== ''
      ? e.command.replace(/\s+/g, ' ').trim()
      : Array.isArray(e.paths) && e.paths.length > 0
        ? [...e.paths].sort((a, b) => a.localeCompare(b)).join(',')
        : '';
  return `${tool}|${detail}`.slice(0, 400);
}

function readMarker(t: DeadTarget): DeadLoopMarker | null {
  const path = markerPath(t);
  if (path === null || !existsSync(path)) {
    return null;
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<DeadLoopMarker>;
    if (typeof raw.signature !== 'string' || typeof raw.ts !== 'number') {
      return null;
    }
    return { signature: raw.signature, count: raw.count ?? 0, ts: raw.ts };
  } catch {
    return null;
  }
}

function writeMarker(t: DeadTarget, m: DeadLoopMarker): void {
  const path = markerPath(t);
  if (path === null) {
    return;
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(m)}\n`);
  } catch {
    // marker is best-effort — detection still reported via context
  }
}

/** post-tool stage: called after journalTrace appended this event.
 *  On a fresh threshold crossing writes/refresh the marker and returns
 *  the advisory lines for the hook context; otherwise nothing. */
export function deadLoopPostTool(
  t: DeadTarget,
  input: { tool_name?: unknown; tool_input?: unknown }
): string[] {
  const loop = matchingLoop(t, input);
  if (loop === null) {
    return [];
  }
  const prior = readMarker(t);
  const fresh = prior !== null && Date.now() - prior.ts < DEAD_LOOP_TTL_MS;
  writeMarker(t, {
    signature: loop.signature,
    count: loop.count,
    ts: Date.now(),
  });
  // warn once per detection cycle — a marker already fresh for this
  // signature means the agent was already told; repeating the warning
  // every call is noise, the pre-tool gate is the enforcement
  if (fresh && prior !== null && prior.signature === loop.signature) {
    return [];
  }
  return [loopWarning(loop)];
}

function matchingLoop(
  t: DeadTarget,
  input: { tool_name?: unknown; tool_input?: unknown }
): { signature: string; count: number; failing: boolean } | null {
  if (t.sessionId === '') {
    return null;
  }
  const loop = trailingLoop(t);
  // The journal and live payload must agree: foreign writes cannot arm
  // this session's gate.
  return loop !== null && deadSignature(input) === loop.signature ? loop : null;
}

function loopWarning(loop: { signature: string; count: number; failing: boolean }): string {
  const [tool, ...detail] = loop.signature.split('|');
  const what = detail.join('|') || loop.signature;
  const fail = loop.failing ? ' (failing)' : '';
  return (
    `⚠ dead loop detected: the same ${tool} call\`${what}\`${fail} repeated ${loop.count}× in a row. ` +
    'Stop retrying it — change approach, gather missing info, or ask the user.'
  );
}

/** pre-tool stage: the gate. Returns the veto reason when this call's
 *  signature matches a fresh dead-loop marker, else null (call runs). */
export function deadLoopPreTool(
  t: DeadTarget,
  input: { tool_name?: unknown; tool_input?: unknown }
): string | null {
  if (t.sessionId === '') {
    return null;
  }
  const marker = readMarker(t);
  if (marker === null || Date.now() - marker.ts >= DEAD_LOOP_TTL_MS) {
    return null;
  }
  if (deadSignature(input) !== marker.signature) {
    return null;
  }
  const what = marker.signature.split('|').slice(1).join('|') || marker.signature;
  return (
    `dead loop gate: \`${what}\` already repeated ${Math.max(marker.count, DEAD_LOOP_REPEAT)}× ` +
    `with no progress — this call was vetoed. Do something different: ` +
    `re-read the error, try another tool/approach, or ask the user.`
  );
}

/** Marker file size is irrelevant but existence is probed per
 *  pre-tool — keep the check cheap: statSync only, no JSON parse on
 *  the hot path beyond what readMarker already does. */
export function deadLoopMarkerExists(t: DeadTarget): boolean {
  const path = markerPath(t);
  try {
    return path !== null && existsSync(path) && statSync(path).size > 0;
  } catch {
    return false;
  }
}
