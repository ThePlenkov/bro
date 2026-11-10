/** Target resolution — the pure half of the session-view lifecycle:
 *  one fleet-state doc + the provider table in, one SessionTarget out.
 *  No fs, no env, no config read — the caller wires those. */
import { eventsVerdict, type PaneLed } from '@broject/acp-session';
import type { ProviderEntry } from '@broject/core';
import type { FleetPaneState } from './state.ts';

/** The resolved acp attach — only when provider type==='acp' and a
 *  session id exists. */
export interface SessionSpec {
  id: string;
  command: string;
  provider?: string;
  model?: string;
}

/** What one refresh resolves — the attach identity plus the display
 *  fields the report carries. `session` present means an ACP attach
 *  is attempted; absent, `log` tails. */
export interface SessionTarget {
  worktree: string;
  /** Display driver name (`agent` field — binary, not provider). */
  agent?: string;
  slug?: string;
  title?: string;
  status: string;
  /** The worker verdict — log-mode LED + label input. */
  workerLed: PaneLed;
  session?: SessionSpec;
  /** The worker's `.events.jsonl` archive — the acp lane's live feed. */
  events?: string;
  /** The fallback stream — the session-owning agent's native log. */
  log?: string;
}

/** The attach dedup key — a new key re-arms the view; identical keys
 *  never re-spawn (a churned state file can't fork acp children). */
export function targetKey(t: SessionTarget | undefined): string {
  if (t === undefined) return 'waiting';
  if (t.events !== undefined) return `events|${t.events}`;
  if (t.session !== undefined) return `acp|${t.session.command}|${t.session.id}`;
  if (t.log !== undefined) return `log|${t.log}`;
  return 'none';
}

/** The acp attach spec one state doc resolves to — only when the
 *  provider entry exists, carries `type === 'acp'`, and the doc names
 *  a session id. Everything else resolves to no session at all. */
function sessionSpecOf(
  s: FleetPaneState,
  providers: Record<string, ProviderEntry>
): SessionSpec | undefined {
  const entry = s.provider !== undefined ? providers[s.provider] : undefined;
  if (entry?.type !== 'acp') return undefined;
  if (s.acpSessionId === undefined) return undefined;
  return {
    id: s.acpSessionId,
    command: entry.command,
    ...(s.provider !== undefined ? { provider: s.provider } : {}),
    ...(s.model !== undefined ? { model: s.model } : {}),
  };
}

export function resolveTarget(
  s: FleetPaneState | undefined,
  worktree: string,
  providers: Record<string, ProviderEntry>
): SessionTarget | undefined {
  if (s === undefined) return undefined;
  const session = sessionSpecOf(s, providers);
  return {
    worktree,
    ...(s.agent !== undefined ? { agent: s.agent } : {}),
    ...(s.slug !== undefined ? { slug: s.slug } : {}),
    title: s.title,
    status: s.status,
    workerLed: s.led,
    ...(session !== undefined ? { session } : {}),
    ...(s.events !== undefined ? { events: s.events } : {}),
    ...(s.log !== undefined ? { log: s.log } : {}),
  };
}

/** The display-agent precedence — driver binary first, then the
 *  provider name, then the slug, `session` last. */
export function sessionAgentOf(t: SessionTarget | undefined): string {
  return t?.agent ?? t?.session?.provider ?? t?.slug ?? 'session';
}

/** The pane's own semantic verdict — the LED answers "is this pane
 *  following a live feed". `mode` is the label detail. */
export interface ViewVerdict {
  led: PaneLed;
  mode: string;
}

/** The attach's current posture — what the refresh reports and what a
 *  resolution move re-arms. */
export interface AttachState {
  /** 'events' once an archive target resolved (the acp lane's live
   *  feed); 'acp' once a session target resolved; 'log' when the
   *  fallback runs; 'none' when the tree carries nothing to show. */
  mode: 'events' | 'acp' | 'log' | 'none';
  /** acp leg: 'connecting' through the handshake, 'live' after
   *  session/load resolved, 'ended' once the transport died or the
   *  attach fell back to the log. */
  acp: 'none' | 'connecting' | 'live' | 'ended';
  /** events leg: the archive's own verdict — last row wins: a turn
   *  start or update is working, a stop is idle, a denied/cancelled
   *  permission is blocked; absent until the first row lands. */
  rowLed?: PaneLed;
  rowMode?: string;
}

export function viewVerdict(t: SessionTarget | undefined, a: AttachState): ViewVerdict {
  if (t === undefined) return { led: { state: 'unknown' }, mode: 'waiting for projector' };
  if (a.mode === 'events') {
    return eventsVerdict(
      t.workerLed,
      a.rowLed !== undefined ? { led: a.rowLed, mode: a.rowMode ?? 'session events' } : undefined
    );
  }
  if (a.mode === 'acp') {
    if (a.acp === 'ended') return { led: { state: 'idle' }, mode: 'session ended' };
    if (a.acp === 'live') return { led: { state: 'working' }, mode: 'session/load' };
    return { led: { state: 'working' }, mode: 'attaching' };
  }
  if (a.mode === 'log') {
    return {
      led: { state: t.workerLed.state === 'working' ? 'working' : 'idle' },
      mode: 'log tail',
    };
  }
  return { led: { state: 'unknown' }, mode: 'no session' };
}
