/** Fire-and-forget OTEL emission — bro's own telemetry plane.
 *  Opt-in via the standard `OTEL_EXPORTER_OTLP_ENDPOINT` (the same env
 *  claude-code reads): log events push to `<ep>/v1/logs`, spans to
 *  `<ep>/v1/traces`, as OTLP/HTTP-JSON with `service.name=bro`. Unset →
 *  silent no-ops. Never throws, never awaited — telemetry must not
 *  stall or fail the request path.
 *
 *  Trace model: one session = one trace. The conductor opens a
 *  `serve.http` span per request and passes its context down —
 *  `acp.open`/`acp.turn` spans nest under it. An incoming `traceparent`
 *  header is honored so instrumented callers (otel claude, sdk clients)
 *  land in the SAME trace; the terminal path (bro spawning `devin acp`
 *  directly) emits the same span names with `peer.*` / `child.*`
 *  attribution from the live process tree. */

import { randomBytes } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

/** Endpoint resolution: process env first, else the bro provider env
 *  file — short-lived CLI calls (hooks, fleet spawns) never source it
 *  themselves but should still emit when the operator wired it. The env
 *  read is cheap enough to stay live (a respawned worker or a test can
 *  repoint mid-life); only the provider.env read is cached. */
let cachedFileEp: string | null | undefined;
const ENDPOINT = (): string | undefined => {
  // BRO_TELEMETRY=0 is the repo-wide telemetry off-switch — the same
  // contract journalCommand and the hook flush honor; the otel plane
  // must not emit (or spawn detached posters) past it either.
  if (process.env.BRO_TELEMETRY === '0') return undefined;
  const env = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (env !== undefined && env !== '') {
    return env.replace(/\/$/, '');
  }
  if (cachedFileEp !== undefined) return cachedFileEp === null ? undefined : cachedFileEp;
  try {
    const line = readFileSync(join(homedir(), '.config', 'bro', 'provider.env'), 'utf8')
      .split('\n')
      .find(l => l.startsWith('OTEL_EXPORTER_OTLP_ENDPOINT='));
    const v = line?.slice(line.indexOf('=') + 1).trim();
    cachedFileEp = v === undefined || v === '' ? null : v.replace(/\/$/, '');
  } catch {
    cachedFileEp = null;
  }
  return cachedFileEp === null ? undefined : cachedFileEp;
};

type AttrValue = string | number | boolean;

function attr(k: string, v: AttrValue): { key: string; value: Record<string, unknown> } {
  if (typeof v === 'number') {
    return Number.isInteger(v)
      ? { key: k, value: { intValue: v } }
      : { key: k, value: { doubleValue: v } };
  }
  if (typeof v === 'boolean') return { key: k, value: { boolValue: v } };
  return { key: k, value: { stringValue: v } };
}

const attrs = (a: Record<string, AttrValue>): { key: string; value: Record<string, unknown> }[] =>
  Object.entries(a).map(([k, v]) => attr(k, v));

const nanos = (ms: number): string => String(BigInt(ms) * 1_000_000n);

const resource = (): { attributes: { key: string; value: Record<string, unknown> }[] } => ({
  attributes: [
    attr('service.name', 'bro'),
    attr('service.version', process.env.BRO_VERSION ?? 'dev'),
  ],
});

/** Emit queue — no in-process OTLP sockets, ever (bro-uwoss). A void'd
 *  fetch to a dead endpoint rejects at its abort yet keeps undici's
 *  connect machinery ref'd ~10s, pinning the CALLER's exit — that is
 *  the measured ~10.5s `bro.cmd hooks` stall and the worker hook-kill
 *  storm. Emissions therefore queue here and ride out on ONE detached
 *  `node -e` child per drain: a dead endpoint can only cost the child,
 *  and the child is wall-clock bounded so it can't accumulate either. */
const emitQueue: Array<[path: string, body: unknown]> = [];
let flushTimer: NodeJS.Timeout | undefined;
let exitArmed = false;

/** Near-real-time lag for long-lived emitters (serve, acp workers) —
 *  unref'd so it never holds a short-lived process open. */
const FLUSH_MS = 2_000;
/** Per-POST abort inside the child — the old post()'s bound, kept. */
const PER_REQUEST_MS = 3_000;
/** Hard self-kill — an undici-pinned child still dies here. */
const CHILD_WALL_MS = 8_000;
/** The batch rides one env slot — cmdline is `ps`-visible to every
 *  local user while /proc/<pid>/environ is same-UID, and the payload
 *  carries error text and session attributes (same rule the serve
 *  watchdog's token hand-off follows). env strings share argv's
 *  per-string MAX_ARG_STRLEN ceiling on Linux — keep chunks under it. */
const EMIT_PAYLOAD_MAX = 96 * 1024;
const EMIT_PAYLOAD_ENV = 'BRO_OTLP_EMIT';

/** The emit child's script: argv[1] endpoint base, `BRO_OTLP_EMIT` a
 *  JSON array of `[path, body]`; POSTs each concurrently with a
 *  per-request abort, then force-exits — `process.exit` is what drops
 *  undici's pinned handles when an aborted connect refuses to clean up.
 *  The wall clock bounds even a fetch that never settles. */
const EMIT_SCRIPT = `const ep=process.argv[1];setTimeout(()=>process.exit(0),${CHILD_WALL_MS});Promise.allSettled(JSON.parse(process.env.${EMIT_PAYLOAD_ENV}??'[]').map(([p,b])=>fetch(ep+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b),signal:AbortSignal.timeout(${PER_REQUEST_MS})}))).then(()=>process.exit(0))`;

/** Drain the queue into env-chunked detached children. Never throws —
 *  a spawn failure loses the chunk it couldn't carry. */
function emit(): void {
  const ep = ENDPOINT();
  const items = emitQueue.splice(0);
  if (ep === undefined || items.length === 0) {
    return;
  }
  let chunk: string[] = [];
  let size = 2; // [] brackets
  const ship = (): void => {
    if (chunk.length === 0) {
      return;
    }
    try {
      const child = spawn(process.execPath, ['-e', EMIT_SCRIPT, ep], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, [EMIT_PAYLOAD_ENV]: `[${chunk.join(',')}]` },
      });
      child.on('error', () => {});
      child.unref();
    } catch {
      // detached emit is best-effort — a spawn failure loses the batch
    }
    chunk = [];
    size = 2;
  };
  for (const item of items) {
    const s = JSON.stringify(item);
    if (size + s.length + 1 > EMIT_PAYLOAD_MAX) {
      ship();
    }
    chunk.push(s);
    size += s.length + 1;
  }
  ship();
}

function enqueue(path: string, body: unknown): void {
  if (ENDPOINT() === undefined) {
    return;
  }
  emitQueue.push([path, body]);
  flushTimer ??= setTimeout(() => {
    flushTimer = undefined;
    emit();
  }, FLUSH_MS);
  flushTimer.unref();
  if (!exitArmed) {
    exitArmed = true;
    // armed on first enqueue — after index.ts's `bro.cmd` exit handler,
    // so its endDetached (enqueue+emit) still lands the final drain
    process.on('exit', emit);
  }
}

function post(path: string, body: unknown): void {
  enqueue(path, body);
}

/** Emit AFTER the caller is gone — a detached node child carries the
 *  payload out while the parent exits. For `process.on('exit')` spans:
 *  the loop is already closing, an in-flight fetch there never runs.
 *  Flushes the whole pending queue — the caller's last span rides with
 *  everything it outlived. */
export function postDetached(path: string, body: unknown): void {
  if (ENDPOINT() === undefined) {
    return;
  }
  emitQueue.push([path, body]);
  emit();
}

/** Local evidence journal — once a process pins a path via
 *  `otelJournal()`, every emitted event also appends one JSONL row
 *  `{ts, event, ...attrs}`. bro serve pins `<git-common>/bro/
 *  serve-turns.jsonl`: `conductor.turn` rows then prove dialect,
 *  model pin and session reuse to a dogfood analyst — no OTLP
 *  collector required. Independent of BRO_TELEMETRY: the journal is
 *  the store's own record, not telemetry. */
let journalPath: string | undefined;
export function otelJournal(path: string | undefined): void {
  journalPath = path;
}

function journal(name: string, a: Record<string, AttrValue>): void {
  if (journalPath === undefined) return;
  try {
    appendFileSync(
      journalPath,
      `${JSON.stringify({ ts: new Date().toISOString(), event: name, ...a })}\n`
    );
  } catch {
    // a journal that can't write must not stall the wire
  }
}

/** Push one OTEL log record. `a` becomes structured metadata —
 *  filterable in loki via `| key="value"` and unwrappable for metrics. */
export function otelEvent(name: string, a: Record<string, AttrValue> = {}): void {
  journal(name, a);
  post('/v1/logs', {
    resourceLogs: [
      {
        resource: resource(),
        scopeLogs: [
          {
            scope: { name: 'bro.serve.events' },
            logRecords: [
              {
                timeUnixNano: nanos(Date.now()),
                body: { stringValue: `bro.${name}` },
                attributes: [attr('event.name', name), ...attrs(a)],
              },
            ],
          },
        ],
      },
    ],
  });
}

/** Span context — a trace/span id pair handed down the call tree.
 *  `parent` links into a caller's trace (e.g. a traceparent header);
 *  undefined parent = this span roots a fresh trace. */
export interface OtelCtx {
  traceId: string;
  spanId: string;
}

export function newTraceId(): string {
  return randomBytes(16).toString('hex');
}
export function newSpanId(): string {
  return randomBytes(8).toString('hex');
}

/** Serialize ctx back to a W3C traceparent — injected into spawned
 *  children (`TRACEPARENT` env) so a subagent's spans nest under the
 *  spawner's trace across the process boundary. */
export function otelHeader(ctx: OtelCtx): string {
  return `00-${ctx.traceId}-${ctx.spanId}-01`;
}

/** Parse a W3C `traceparent` (`00-<trace>-<span>-<flags>`) into a
 *  parent context — the conductor honors the incoming header so an
 *  instrumented caller's spans and ours land in one trace. */
export function otelParent(header: string | string[] | undefined): OtelCtx | undefined {
  const h = Array.isArray(header) ? header[0] : header;
  if (h === undefined) return undefined;
  const m = /^[\da-f]{2}-([\da-f]{32})-([\da-f]{16})-[\da-f]{2}$/.exec(h.trim());
  if (m === null || m[1] === '0'.repeat(32) || m[2] === '0'.repeat(16)) return undefined;
  return { traceId: m[1]!, spanId: m[2]! };
}

/** Ambient span context — set by the entry point (the `bro.cmd` span)
 *  so code deep in a command (hook probes, acp turns) nests without
 *  threading a param through every signature. Explicit per-call
 *  parents always win (the conductor's per-request span is ambient-
 *  unsafe: concurrent requests would cross-link). */
let ambient: OtelCtx | undefined;
export function setAmbient(ctx: OtelCtx | undefined): void {
  ambient = ctx;
}

/** Parent resolution order: explicit param → ambient → TRACEPARENT env
 *  (the spawned-child leg — a worker's spans join its spawner's trace). */
function resolveParent(explicit?: OtelCtx): OtelCtx | undefined {
  return explicit ?? ambient ?? otelParent(process.env.TRACEPARENT);
}

export interface OtelSpan {
  /** Hand this down to nested emissions so their spans attach here. */
  ctx: OtelCtx;
  /** Emit the completed span. `status` 'error' flips the OTEL flag. */
  end: (a?: Record<string, AttrValue>, status?: 'ok' | 'error') => void;
  /** Same as end() but delivered by a detached child — the only shape
   *  that survives `process.on('exit')` (loop already closing). */
  endDetached: (a?: Record<string, AttrValue>, status?: 'ok' | 'error') => void;
}

/** Open a span; nothing is sent until `.end()`. `startMs` defaults to
 *  now — pass an earlier timestamp to cover work already started. */
function spanBody(
  name: string,
  a: Record<string, AttrValue>,
  ctx: OtelCtx,
  parent: OtelCtx | undefined,
  startMs: number,
  endMs: number,
  status: 'ok' | 'error',
  kind: number
): unknown {
  return {
    resourceSpans: [
      {
        resource: resource(),
        scopeSpans: [
          {
            scope: { name: 'bro.acp' },
            spans: [
              {
                traceId: ctx.traceId,
                spanId: ctx.spanId,
                ...(parent === undefined ? {} : { parentSpanId: parent.spanId }),
                name,
                kind,
                startTimeUnixNano: nanos(startMs),
                endTimeUnixNano: nanos(endMs),
                attributes: attrs(a),
                status:
                  status === 'error' ? { code: 2, message: String(a['error'] ?? '') } : { code: 1 },
              },
            ],
          },
        ],
      },
    ],
  };
}

export function otelSpan(
  name: string,
  a: Record<string, AttrValue> = {},
  opts: { parent?: OtelCtx; startMs?: number; kind?: number } = {}
): OtelSpan {
  const parent = resolveParent(opts.parent);
  const ctx: OtelCtx = { traceId: parent?.traceId ?? newTraceId(), spanId: newSpanId() };
  const startMs = opts.startMs ?? Date.now();
  const kind = opts.kind ?? 2; // SPAN_KIND_SERVER
  return {
    ctx,
    end: (more = {}, status = 'ok') =>
      post(
        '/v1/traces',
        spanBody(name, { ...a, ...more }, ctx, parent, startMs, Date.now(), status, kind)
      ),
    /** Complete the span via a detached child — safe inside an
     *  'exit' handler where the event loop is already closing. */
    endDetached: (more = {}, status = 'ok') =>
      postDetached(
        '/v1/traces',
        spanBody(name, { ...a, ...more }, ctx, parent, startMs, Date.now(), status, kind)
      ),
  };
}
