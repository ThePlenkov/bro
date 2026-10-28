/**
 * The readonly ACP session renderer (spec bro-5vjpg) — a pure, sink-fed
 * line-mode view of one ACP session's `session/update` stream. No ACP
 * client lives here: the driver feeds decoded updates and permission
 * requests, this file turns them into appended terminal lines. No
 * backend branches either — the contract is the ACP wire shape only.
 *
 * Rendering rules (scrollback-friendly, no curses):
 *   agent_thought_chunk  → dim text (same-kind runs coalesce to a line)
 *   agent_message_chunk  → plain text (same)
 *   tool_call(_update)   → `⣿ <title> [<kind>] <status>` per transition
 *   plan                 → a re-rendered checklist block
 *   request_permission   → `⚠ <title> [options]` + the auto-answer
 *   everything else      → dim one-liners; unknown kinds stay visible
 */
export interface SessionUpdateLike {
  sessionUpdate: string;
  [k: string]: unknown;
}

export interface PermissionRequestLike {
  toolCall?: { toolCallId?: string; title?: string | null; kind?: string | null } | null;
  options?: { optionId?: string; name?: string; kind?: string }[] | null;
}

const DIM = '\u001b[2m';
const GREEN = '\u001b[32m';
const RED = '\u001b[31m';
const YELLOW = '\u001b[33m';
const RESET = '\u001b[0m';

// Built from strings so the source holds no control-byte escapes —
// the scanner's control-char rule keys on regex literals.
const CSI_RE = new RegExp(
  '\\u001b\\[[0-9;:?]*[a-zA-Z]|\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)|\\u001b[@-Z\\\\-_]',
  'g'
);
const CTRL_RE = new RegExp('[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f]', 'g');

/** Agent-controlled text may carry control bytes — strip everything
 *  non-printable so a hostile or buggy backend cannot write escape
 *  sequences into the pane. Line-mode invariant too: newlines become
 *  a visible `⏎`, never a second line. */
export const safe = (s: string): string =>
  s.replace(CSI_RE, '').replace(CTRL_RE, '').replaceAll('\r', '').replaceAll('\n', ' ⏎ ');

/** The fixed permission policy (spec): reads (and other observably
 *  non-mutating kinds) may be remembered ALWAYS; everything else is
 *  once-only. A backend that offers no allow-kind option gets a
 *  cancelled outcome — an invented approval is not a viewer's call. */
const ALWAYS_KINDS = new Set(['read', 'search', 'fetch', 'think']);

interface PermOption {
  optionId?: string;
  name?: string;
  kind?: string;
}

/** The resolved policy for one request — mode, kind verdict, and
 *  whether this request must be denied. */
interface PermPolicy {
  mode: string;
  readKind: boolean;
  deny: boolean;
}

/** Deny path: reject_once first (least committed), reject_always next.
 *  Allow path: reads prefer allow_always, then allow_once; non-reads
 *  prefer allow_once, then allow_always. A deny never falls through
 *  to an allow. */
const pickOption = (options: PermOption[], pol: PermPolicy): PermOption | undefined => {
  const find = (kind: string) => options.find(o => o.kind === kind);
  if (pol.deny) return find('reject_once') ?? find('reject_always');
  const first = pol.readKind ? find('allow_always') : find('allow_once');
  const second = pol.readKind ? find('allow_once') : find('allow_always');
  return first ?? second;
};

const whyText = (pol: PermPolicy): string => {
  if (pol.deny) return `denied — policy: permit=${pol.mode}`;
  return pol.readKind ? 'read-kind tool → allow-always' : 'default → allow-once';
};

export interface RenderOpts {
  /** ANSI styling — off for captured/plain output. */
  color?: boolean;
}

const STATUS_COLOR: Record<string, string> = { completed: GREEN, failed: RED };
const PLAN_BOX: Record<string, string> = { completed: '[x]', in_progress: '[>]', pending: '[ ]' };

/** Wire value → display scalar; objects get a `?` instead of
 *  `[object Object]` — status lines only carry primitives. */
const scalar = (v: unknown): string =>
  v !== null && typeof v === 'object' ? '?' : String(v ?? '?');

interface ToolRec {
  title?: string;
  name?: string;
  kind?: string;
  status?: string;
}

export class AcpRenderer {
  private readonly out: (line: string) => void;
  private readonly color: boolean;
  private readonly tools = new Map<string, ToolRec>();
  /** The coalescing buffer — chunk deltas stream token-level, so a
   *  same-kind run accumulates into one printed line (acp-worker's
   *  buffering, kept on the render side). */
  private buf: { kind: string; text: string } | undefined;
  /** Sideband notice dedupe — a backend's `_vendor/output` can run to
   *  dozens of events; each method prints once, repeats count, and
   *  the tally lands at the next structural boundary. */
  private readonly notices = new Map<string, number>();

  constructor(out: (line: string) => void, opts: RenderOpts = {}) {
    this.out = out;
    this.color = opts.color !== false;
  }

  private paint(code: string, text: string): string {
    return this.color ? `${code}${text}${RESET}` : text;
  }

  private dim(text: string): string {
    return this.paint(DIM, text);
  }

  /** Anything buffered must land before the next structural line —
   *  every render path that isn't a same-kind chunk flushes first. */
  private flush(): void {
    if (this.buf === undefined) return;
    const { kind, text } = this.buf;
    this.buf = undefined;
    if (text === '') return;
    this.out(kind === 'agent_message_chunk' ? text : this.dim(text));
  }

  /** Suppressed repeat tallies land before closing markers so the
   *  sideband's volume stays on record without the spam. */
  private flushNotices(): void {
    for (const [method, n] of this.notices) {
      if (n > 1) this.out(this.dim(`[${method}] ×${n}`));
    }
    this.notices.clear();
  }

  /** One buffered chunk of the given kind — flushes on a kind switch. */
  private chunk(kind: string, text: string): void {
    if (this.buf?.kind === kind) {
      this.buf.text += text;
      return;
    }
    this.flush();
    this.buf = { kind, text };
  }

  private static textOf(u: SessionUpdateLike): string {
    const c = u['content'] as { type?: string; text?: string } | undefined;
    return c?.type === 'text' && typeof c.text === 'string'
      ? safe(c.text)
      : `[${safe(u.sessionUpdate)}: ${c?.type ?? '?'}]`;
  }

  private toolLine(rec: ToolRec, status: string): void {
    const label = rec.title ?? rec.name ?? 'tool';
    const kind = rec.kind !== undefined && rec.kind !== '' ? ` [${rec.kind}]` : '';
    const c = STATUS_COLOR[status];
    const glyph = c !== undefined ? this.paint(c, '⣿') : '⣿';
    const word = c !== undefined ? this.paint(c, status) : this.dim(status);
    this.out(`${glyph} ${label}${kind} ${word}`);
  }

  private onTool(u: SessionUpdateLike): void {
    const t = u as {
      toolCallId?: string;
      title?: string | null;
      name?: string | null;
      kind?: string | null;
      status?: string | null;
    };
    const id = t.toolCallId ?? '?';
    const rec = this.tools.get(id) ?? {};
    for (const k of ['title', 'name', 'kind'] as const) {
      const v = t[k];
      if (typeof v === 'string' && v !== '') rec[k] = safe(v);
    }
    const status = typeof t.status === 'string' && t.status !== '' ? safe(t.status) : 'pending';
    // a repeat of the seen status is churn (content mid-streams share
    // it); only lifecycle edges print
    if (rec.status === status) {
      this.tools.set(id, rec);
      return;
    }
    rec.status = status;
    this.tools.set(id, rec);
    this.toolLine(rec, status);
  }

  private onPlan(u: SessionUpdateLike): void {
    const entries = (u['entries'] as { content?: string; status?: string }[] | undefined) ?? [];
    this.out(this.dim('── plan ──'));
    for (const e of entries) {
      const box = PLAN_BOX[e.status ?? ''] ?? '[~]';
      this.out(`  ${box} ${e.content !== undefined ? safe(e.content) : '?'}`);
    }
  }

  private onUsage(u: SessionUpdateLike): void {
    const t = u as { used?: unknown; size?: unknown };
    this.out(this.dim(`◌ usage ${scalar(t.used)}/${scalar(t.size)}`));
  }

  private onConfig(u: SessionUpdateLike): void {
    const opts =
      (u['configOptions'] as { id?: string; currentValue?: unknown }[] | undefined) ?? [];
    const kv = opts.map(o => `${safe(o.id ?? '?')}=${safe(scalar(o.currentValue))}`).join(' ');
    this.out(this.dim(`config ${kv}`));
  }

  private onMode(u: SessionUpdateLike): void {
    this.out(this.dim(`mode → ${safe(scalar((u as { currentModeId?: unknown }).currentModeId))}`));
  }

  private onCommands(u: SessionUpdateLike): void {
    const cmds = (u['availableCommands'] as unknown[] | undefined) ?? [];
    this.out(this.dim(`${cmds.length} commands`));
  }

  private onSessionInfo(u: SessionUpdateLike): void {
    const title = (u as { title?: unknown }).title;
    this.out(
      this.dim(`session ${typeof title === 'string' && title !== '' ? safe(title) : '(info)'}`)
    );
  }

  private onSubagent(u: SessionUpdateLike): void {
    const s = u as { sessionId?: string; title?: string | null; description?: string | null };
    const desc =
      s.description != null && s.description !== '' ? this.dim(` — ${safe(s.description)}`) : '';
    this.out(`⎇ subagent ${safe(s.title ?? s.sessionId ?? '?')}${desc}`);
  }

  /** The one-line-per-kind renderers — every entry flushes the chunk
   *  buffer first (a structural line always lands in order). */
  private readonly structured: Record<string, (u: SessionUpdateLike) => void> = {
    usage_update: u => this.onUsage(u),
    config_option_update: u => this.onConfig(u),
    current_mode_update: u => this.onMode(u),
    available_commands_update: u => this.onCommands(u),
    session_info_update: u => this.onSessionInfo(u),
    subagent_update: u => this.onSubagent(u),
  };

  /** One session/update value (params.update on the wire). */
  update(u: SessionUpdateLike): void {
    switch (u.sessionUpdate) {
      case 'agent_thought_chunk':
      case 'user_message_chunk':
        this.chunk(u.sessionUpdate, AcpRenderer.textOf(u));
        return;
      case 'agent_message_chunk':
        this.chunk('agent_message_chunk', AcpRenderer.textOf(u));
        return;
      case 'tool_call':
      case 'tool_call_update':
        this.flush();
        this.onTool(u);
        return;
      case 'plan':
        this.flush();
        this.onPlan(u);
        return;
      default:
        this.flush();
        (
          this.structured[u.sessionUpdate] ??
          (x => this.out(this.dim(`[${safe(x.sessionUpdate)}]`)))
        )(u);
        return;
    }
  }

  /** A non-session/update notification (ext methods like
   *  `_vendor/output`) — rendered dim so a backend's sideband log
   *  stays visible without pretending to be the session. First sight
   *  prints; repeats only count toward the trailing `×N` tally. */
  notice(method: string, params?: unknown): void {
    this.flush();
    const n = (this.notices.get(method) ?? 0) + 1;
    this.notices.set(method, n);
    if (n > 1) return;
    const p = (params ?? {}) as { channel?: string; message?: string; level?: string };
    const text =
      typeof p.channel === 'string' && typeof p.message === 'string'
        ? `‹${safe(p.channel)}› ${safe(p.message)}`
        : `[${safe(method)}]`;
    this.out(this.dim(text));
  }

  /** `session/request_permission` — render the chip and answer per the
   *  policy; returns the response `outcome` object for the wire.
   *  `mode`: `auto` is the spec's fixed policy (reads → allow_always,
   *  else → allow_once); `reads` approves read-kind tools only and
   *  rejects the rest; `none` rejects everything. A backend offering
   *  no matching option gets cancelled — an invented answer is not a
   *  viewer's call. */
  permission(
    params: PermissionRequestLike,
    mode: 'auto' | 'reads' | 'none' = 'auto'
  ): { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } {
    this.flush();
    const title = safe(
      params.toolCall?.title ?? params.toolCall?.toolCallId ?? 'permission request'
    );
    const options = params.options ?? [];
    const names = options.map(o => safe(o.name ?? o.optionId ?? '?')).join(', ');
    this.out(`${this.paint(YELLOW, '⚠')} ${title} [${names}]`);
    const readKind = params.toolCall?.kind != null && ALWAYS_KINDS.has(params.toolCall.kind);
    const pol: PermPolicy = {
      mode,
      readKind,
      deny: mode === 'none' || (mode === 'reads' && !readKind),
    };
    const pick = pickOption(options, pol);
    if (pick === undefined) {
      this.out(this.dim(`  → cancelled — permit=${mode}, no matching option offered`));
      return { outcome: 'cancelled' };
    }
    const why = whyText(pol);
    this.out(
      this.dim(
        `  → auto-answered ${safe(pick.name ?? pick.optionId ?? '?')} (${safe(pick.kind ?? '?')}) — ${why}`
      )
    );
    return { outcome: 'selected', optionId: pick.optionId ?? '' };
  }

  /** An agent→client call the watcher does not serve (fs, terminal,
   *  elicitation — unadvertised caps) — visible, then method-not-found. */
  unhandled(method: string): void {
    this.flush();
    this.out(this.dim(`[${safe(method)}] — unadvertised, method-not-found`));
  }

  /** Turn boundary — session/prompt resolved with a stop reason. */
  turnEnd(stopReason: string | undefined): void {
    this.flush();
    this.flushNotices();
    this.out(
      this.dim(`── turn complete (${stopReason !== undefined ? safe(stopReason) : 'unknown'}) ──`)
    );
  }

  /** The closing marker — child exit, transport death, or a terminal
   *  turn. The pane keeps its scrollback; only the session is over. */
  closed(detail: string): void {
    this.flush();
    this.flushNotices();
    this.out(this.dim(`── session ended (${safe(detail)}) — scrollback kept ──`));
  }

  /** Any trailing buffered chunk lands as its own line. */
  end(): void {
    this.flush();
    this.flushNotices();
  }
}
