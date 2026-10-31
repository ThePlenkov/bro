/**
 * The vendored-model spike (spec bro-q2edc) — replay a real
 * `.events.jsonl` archive through `acp-model`'s `reduce()` and print
 * what survives, beside the same tail through our `model.ts`.
 *
 *   bun run plugins/herdr/tui/spike-feed.ts <events.jsonl>
 *
 * The adapter contract: the archive is a REPLAY of another client's
 * session, so the feed opens with `session_opening` (mode `load`) —
 * every item then carries `origin: "replay"` — and closes with
 * `session_opened`, which finalises everything. `turn stop` rows map
 * to `prompt_response` (the turn_end marker lands; duration is 0 —
 * the archive never records the client's prompt_sent). `turn start`
 * maps to nothing: `prompt_sent` would fabricate a user_message the
 * archive does not carry. Permission rows map to `permission_opened`
 * with a minimal synthesized request.
 */
import { readFileSync } from 'node:fs';
import type { LoadSessionResponse, SessionUpdate, StopReason } from '@agentclientprotocol/sdk';
import {
  type ArchiveRow,
  parseArchiveRows,
} from '../../../packages/cli/src/commands/session-feed.ts';
import { SessionModel } from './model.ts';
import {
  createSession,
  type ModelEvent,
  reduce,
  type Session,
} from './vendor/acp-model/src/index.ts';

const at = (row: ArchiveRow): number => {
  const ts = (row as { ts?: string }).ts;
  const ms = ts !== undefined ? Date.parse(ts) : NaN;
  return Number.isNaN(ms) ? 0 : ms;
};

/** One archive row → the ModelEvents it means (usually one, turn
 *  start maps to none). */
function eventsOf(row: ArchiveRow): ModelEvent[] {
  const t = at(row);
  if (row.kind === 'update' && row.update !== undefined) {
    return [{ type: 'session_update', update: row.update as SessionUpdate, at: t }];
  }
  if (row.kind === 'turn' && row.phase === 'stop') {
    return [
      {
        type: 'prompt_response',
        stopReason: (row.stopReason ?? 'end_turn') as StopReason,
        at: t,
      },
    ];
  }
  if (row.kind === 'permission') {
    const toolCallId = ((row as { toolCallId?: string }).toolCallId ?? 'unknown') as never;
    return [
      {
        type: 'permission_opened',
        toolCallId,
        request: {
          sessionId: 'archive' as never,
          toolCall: {
            toolCallId,
            title: row.title ?? 'permission',
            status: 'in_progress',
          },
          options: [],
        },
        at: t,
      },
    ];
  }
  return [];
}

// --- report ------------------------------------------------------------------

const path = process.argv[2];
if (path === undefined) {
  console.error('usage: spike-feed.ts <events.jsonl>');
  process.exit(2);
}
const text = readFileSync(path, 'utf8');
const rows = parseArchiveRows(text);

let session: Session = reduce(createSession(), {
  type: 'session_opening',
  mode: 'load',
  sessionId: 'archive' as never,
  cwd: '/archive',
  at: 0,
});
const unknown: Record<string, number> = {};
const t0 = Date.now();
for (const row of rows) {
  for (const ev of eventsOf(row)) {
    session = reduce(session, ev, info => {
      const k = `${info.kind}:${'sessionUpdate' in info ? info.sessionUpdate : ''}`;
      unknown[k] = (unknown[k] ?? 0) + 1;
    });
  }
}
session = reduce(session, {
  type: 'session_opened',
  response: {} as LoadSessionResponse,
  at: 0,
});
const feedMs = Date.now() - t0;

const byKind: Record<string, number> = {};
const byOrigin: Record<string, number> = {};
const byStatus: Record<string, number> = {};
const contentTypes: Record<string, number> = {};
const markers: Record<string, number> = {};
let toolCalls = 0;
let withContent = 0;
let withRawOutput = 0;
for (const item of session.items.values()) {
  byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;
  byOrigin[item.origin] = (byOrigin[item.origin] ?? 0) + 1;
  byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
  if (item.kind === 'tool_call') {
    toolCalls++;
    if (item.content.length > 0) withContent++;
    if (item.rawOutputText !== null) withRawOutput++;
    for (const c of item.content) {
      contentTypes[c.type] = (contentTypes[c.type] ?? 0) + 1;
    }
  }
  if (item.kind === 'marker') {
    markers[item.markerKind] = (markers[item.markerKind] ?? 0) + 1;
  }
}
console.log('== acp-model ==');
console.log(`rows=${rows.length} feedMs=${feedMs}`);
console.log(`items=${session.items.size} order=${session.order.length}`);
console.log(`byKind=${JSON.stringify(byKind)}`);
console.log(`byOrigin=${JSON.stringify(byOrigin)} byStatus=${JSON.stringify(byStatus)}`);
console.log(`markers=${JSON.stringify(markers)}`);
console.log(`toolCalls=${toolCalls} withContent=${withContent} withRawOutput=${withRawOutput}`);
console.log(`contentTypes=${JSON.stringify(contentTypes)}`);
console.log(
  `state=${session.state} stopReason=${session.stopReason} replaying=${session.replaying}`
);
const unknownKeys = Object.keys(unknown);
if (unknownKeys.length > 0) {
  console.log(`debug-dropped=${unknownKeys.map(k => `${k}=${unknown[k]}`).join(' ')}`);
}

// --- ours, same rows ---------------------------------------------------------

const ours = new SessionModel();
const t1 = Date.now();
for (const row of rows) ours.feed(row);
const oursMs = Date.now() - t1;
console.log('== ours (SessionModel) ==');
console.log(`feedMs=${oursMs} items=${ours.items.length} dumpLines=${ours.dump().length}`);
