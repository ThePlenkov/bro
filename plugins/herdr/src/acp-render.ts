/**
 * The readonly ACP session renderer (spec bro-5vjpg) — a pure, sink-fed
 * line-mode view of one ACP session's `session/update` stream. No ACP
 * client lives here: the driver feeds decoded updates and permission
 * requests, this file turns them into appended terminal lines. No
 * backend branches either — the contract is the ACP wire shape only.
 *
 * Rendering rules (scrollback-friendly, no curses):
 *   agent_thought_chunk  → dim paragraphs (same-kind runs coalesce;
 *                          real newlines, never ⏎-flattened)
 *   agent_message_chunk  → plain paragraphs (same)
 *   tool_call(_update)   → `⣿/✓/✗ <title> [<kind>] <arg>` per status
 *                          edge + an indented `│` output card on the
 *                          finished edge — text block, diff +/-,
 *                          terminal note — bounded per item & card
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

const isCtrl = (c: number): boolean => c < 9 || (c > 10 && c < 32) || (c > 126 && c < 160);

/** Cursor over the wire string — carries s + position so the escape
 *  scanners share state instead of threading (string, number) pairs. */
interface Cur {
  s: string;
  i: number;
}

/** CSI final byte lives in 0x40–0x7e. */
const isFinal = (c: number): boolean => c > 0x3f && c < 0x7f;

const csiEnd = (c: Cur): void => {
  while (c.i < c.s.length && !isFinal(c.s.charCodeAt(c.i))) c.i++;
};

/** OSC ends at BEL or the two-char terminator ESC\. */
const oscStop = (c: Cur): boolean =>
  c.s.charCodeAt(c.i) === 0x07 || (c.s.charCodeAt(c.i) === 0x1b && c.s[c.i + 1] === '\\');

const oscEnd = (c: Cur): void => {
  while (c.i < c.s.length && !oscStop(c)) c.i++;
  if (c.s.charCodeAt(c.i) === 0x1b) c.i++;
};

/** Lands on the sequence's last char — the caller's loop steps past
 *  it. ESC + one char is the degenerate case: stay on that char. */
const escSkip = (c: Cur): void => {
  const kind = c.s[c.i + 1];
  c.i++;
  if (kind === '[') {
    c.i++;
    csiEnd(c);
  } else if (kind === ']') {
    c.i++;
    oscEnd(c);
  }
};

/** Agent-controlled text may carry control bytes — strip everything
 *  non-printable so a hostile or buggy backend cannot write escape
 *  sequences into the pane. Line-mode invariant too: newlines become
 *  a visible `⏎`, never a second line. */
export const safe = (s: string): string => {
  const c: Cur = { s, i: 0 };
  let out = '';
  for (; c.i < s.length; c.i++) {
    const ch = s.charCodeAt(c.i);
    if (ch === 0x1b) escSkip(c);
    else if (ch === 0x0a) out += ' ⏎ ';
    else if (!isCtrl(ch) && ch !== 0x0d) out += s[c.i];
  }
  return out;
};

/** The block variant of safe() — same ESC/control strip but REAL
 *  newlines pass through: a `\n` in agent text is a line break, never
 *  a ⏎. Output paths split on it; agent-controlled ANSI still cannot
 *  reach the pane (the pane is a real terminal — pass-through means
 *  an agent owns the display). */
export const safeBlock = (s: string): string => {
  const c: Cur = { s, i: 0 };
  let out = '';
  for (; c.i < s.length; c.i++) {
    const ch = s.charCodeAt(c.i);
    if (ch === 0x1b) escSkip(c);
    else if (ch === 0x0a) out += '\n';
    else if (!isCtrl(ch) && ch !== 0x0d) out += s[c.i];
  }
  return out;
};

/** One emitted line's width — past it the tail collapses to '…'. Every
 *  printed line is clipped BEFORE paint so ANSI never eats the count.
 *  `n` lets a caller spend a smaller budget (an arg fitting what's
 *  left of the header); under ~4 chars nothing legible survives. */
export const LINE_MAX = 120;
export const clip = (s: string, n = LINE_MAX): string =>
  n < 4 ? '' : s.length > n ? `${s.slice(0, n - 1)}…` : s;

/** Tool-card bounds — a chatty tool cannot flood the scrollback: each
 *  content item shows at most ITEM_MAX lines, each card at most
 *  CARD_MAX lines; overflow lands as `… (N more)`. */
const ITEM_MAX = 10;
const CARD_MAX = 30;

/** Statuses that finish a tool call — the card edge. */
export const DONE_STATUS = new Set(['completed', 'failed']);

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

const PLAN_BOX: Record<string, string> = { completed: '[x]', in_progress: '[>]', pending: '[ ]' };

/** Wire value → display scalar; objects get a `?` instead of
 *  `[object Object]` — status lines only carry primitives. */
const scalar = (v: unknown): string => {
  const t = typeof v;
  return t === 'string' || t === 'number' || t === 'boolean' ? String(v) : '?';
};

interface ToolRec {
  title?: string;
  name?: string;
  kind?: string;
  status?: string;
  /** The header's one meaningful argument — a rawInput key picked by
   *  tool kind, else locations[0] — sanitized and clipped at learn. */
  arg?: string;
  /** Last PRINTED edge bucket — 'live' covers pending+in_progress so a
   *  status flip that changes no glyph never duplicates the header. */
  edge?: string;
  /** The output card rendered once — a content-carrying repeat of a
   *  terminal status still lands, but the card never prints twice. */
  body?: boolean;
}

/** rawInput keys worth printing, by tool kind — `bash <cmd>`,
 *  `grep <pattern>`, `fetch <url>` each have one arg a human scans
 *  for; everything else falls to the generic order below. */
const ARG_KEYS: Record<string, string[]> = {
  execute: ['command', 'cmd'],
  search: ['pattern', 'query'],
  fetch: ['url'],
  think: ['description', 'thought'],
};

/** Kind-blind arg order — a path beats a command when both appear
 *  (an edit's `file_path` is the identity, `command` its payload). */
const ARG_FALLBACK = ['path', 'file_path', 'filePath', 'command', 'pattern', 'url', 'query'];

export interface ToolWire {
  rawInput?: unknown;
  locations?: { path?: unknown }[] | null;
}

/** The one arg on the header — a kind-guided rawInput key first, the
 *  generic list next, a bare-string rawInput, then locations[0].
 *  Sanitized + clipped here so the header just interpolates. */
export function toolArg(u: ToolWire, kind: string | undefined): string | undefined {
  if (typeof u.rawInput === 'string' && u.rawInput !== '') return clip(safe(u.rawInput));
  if (typeof u.rawInput === 'object' && u.rawInput !== null) {
    const raw = u.rawInput as Record<string, unknown>;
    const keys = [...(kind !== undefined ? (ARG_KEYS[kind] ?? []) : []), ...ARG_FALLBACK];
    for (const k of keys) {
      const v = raw[k];
      if (typeof v === 'string' && v !== '') return clip(safe(v));
    }
  }
  const loc = u.locations?.find(l => typeof l.path === 'string' && l.path !== '');
  return loc !== undefined ? clip(safe(loc.path as string)) : undefined;
}

/** The text a message/thought chunk carries — sanitized block text,
 *  or a bracketed marker for non-text content. */
export function chunkText(u: SessionUpdateLike): string {
  const c = u['content'] as { type?: string; text?: string } | undefined;
  return c?.type === 'text' && typeof c.text === 'string'
    ? safeBlock(c.text)
    : `[${safe(u.sessionUpdate)}: ${c?.type ?? '?'}]`;
}

/** One tool `content[]` entry, classified — the shape every pane
 *  frontend renders from: text output, a file patch, a terminal
 *  handle (output is not archived), or an opaque unknown. */
export type ToolContent =
  | { kind: 'text'; text: string }
  | { kind: 'diff'; path: string; old?: string; cur?: string }
  | { kind: 'terminal'; id: string }
  | { kind: 'unknown'; type: string };

/** The wire-shape → ToolContent parse — one entry of a tool call's
 *  `content[]` (spec bro-5vjpg). Text blocks sanitize through
 *  safeBlock (newlines kept, controls gone); everything else carries
 *  its scalars pre-cleaned for a header slot. */
export function toolContent(item: unknown): ToolContent {
  const it = item as {
    type?: unknown;
    content?: { type?: unknown; text?: unknown };
    path?: unknown;
    oldText?: unknown;
    newText?: unknown;
    terminalId?: unknown;
  };
  switch (it.type) {
    case 'content': {
      const c = it.content;
      if (c?.type === 'text' && typeof c.text === 'string') {
        return { kind: 'text', text: safeBlock(c.text) };
      }
      return { kind: 'unknown', type: safe(typeof c?.type === 'string' ? c.type : '?') };
    }
    case 'diff':
      return {
        kind: 'diff',
        path: safe(typeof it.path === 'string' ? it.path : '?'),
        old: typeof it.oldText === 'string' ? safeBlock(it.oldText) : undefined,
        cur: typeof it.newText === 'string' ? safeBlock(it.newText) : undefined,
      };
    case 'terminal':
      return { kind: 'terminal', id: safe(String(it.terminalId ?? '?')) };
    default:
      return { kind: 'unknown', type: safe(typeof it.type === 'string' ? it.type : '?') };
  }
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
   *  every render path that isn't a same-kind chunk flushes first.
   *  Paragraphs, not a ⏎-flattened single: a newline inside the
   *  buffered text is a real line break (thought stays dim). */
  private flush(): void {
    if (this.buf === undefined) return;
    const { kind, text } = this.buf;
    this.buf = undefined;
    if (text === '') return;
    const dimmed = kind !== 'agent_message_chunk';
    for (const line of text.split('\n')) {
      this.out(line === '' ? '' : dimmed ? this.dim(clip(line)) : clip(line));
    }
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

  /** One content item → its `│`-indented card lines (already painted):
   *  text block, diff +/- lines under a path header, terminal note,
   *  or a dim bracket for shapes the archive can't display. The parse
   *  is the shared `toolContent` classifier — only painting is local. */
  private itemLines(item: unknown): string[] {
    const c = toolContent(item);
    switch (c.kind) {
      case 'text':
        return this.capItem(c.text.split('\n').map(l => `│  ${clip(l)}`));
      case 'diff': {
        const head = `│  ${this.dim(`─ ${clip(c.path)}`)}`;
        const body: string[] = [];
        if (c.old !== undefined) {
          for (const l of c.old.split('\n')) {
            body.push(`│  ${this.paint(RED, `- ${clip(l)}`)}`);
          }
        }
        if (c.cur !== undefined) {
          for (const l of c.cur.split('\n')) {
            body.push(`│  ${this.paint(GREEN, `+ ${clip(l)}`)}`);
          }
        }
        return [head, ...this.capItem(body)];
      }
      case 'terminal':
        return [`│  ${this.dim(`terminal output is not archived (terminal ${c.id})`)}`];
      case 'unknown':
        return [`│  ${this.dim(`[${c.type}]`)}`];
    }
  }

  /** The header line — glyph per status edge (⣿ live, ✓ green,
   *  ✗ red), then `title [kind] arg`; kind+arg dim so the title leads.
   *  The arg spends what the title+kind leave of LINE_MAX — a header
   *  is a single line and gets the same bound as every other. */
  private toolLine(rec: ToolRec, status: string): void {
    const glyph =
      status === 'completed'
        ? this.paint(GREEN, '✓')
        : status === 'failed'
          ? this.paint(RED, '✗')
          : '⣿';
    const head = `${glyph} ${clip(rec.title ?? rec.name ?? 'tool')}`;
    const kind = rec.kind !== undefined && rec.kind !== '' ? ` [${rec.kind}]` : '';
    const arg =
      rec.arg !== undefined && rec.arg !== ''
        ? ` ${clip(rec.arg, LINE_MAX - head.length - kind.length)}`
        : '';
    this.out(`${head}${kind === '' ? '' : this.dim(kind)}${arg === '' ? '' : this.dim(arg)}`);
  }

  /** A per-item line cap — overflow collapses to one `… (N more)`. */
  private capItem(lines: string[]): string[] {
    if (lines.length <= ITEM_MAX) return lines;
    return [...lines.slice(0, ITEM_MAX), `│  ${this.dim(`… (${lines.length - ITEM_MAX} more)`)}`];
  }

  /** The card body under a finished call — per-item cap inside,
   *  CARD_MAX lines total; remaining items fold into one tally. */
  private toolBody(items: unknown[]): void {
    let used = 0;
    for (let i = 0; i < items.length; i++) {
      const room = CARD_MAX - used;
      if (room <= 0) {
        this.out(`│  ${this.dim(`… (${items.length - i} more)`)}`);
        return;
      }
      const lines = this.itemLines(items[i]);
      for (const l of lines.slice(0, room)) this.out(l);
      used += Math.min(lines.length, room);
      if (lines.length > room) {
        this.out(`│  ${this.dim(`… (${lines.length - room} more)`)}`);
        return;
      }
    }
  }

  private onTool(u: SessionUpdateLike): void {
    const t = u as {
      toolCallId?: string;
      title?: string | null;
      name?: string | null;
      kind?: string | null;
      status?: string | null;
      content?: unknown;
      rawInput?: unknown;
      locations?: { path?: unknown }[] | null;
    };
    const id = t.toolCallId ?? '?';
    const rec = this.tools.get(id) ?? {};
    for (const k of ['title', 'name', 'kind'] as const) {
      const v = t[k];
      if (typeof v === 'string' && v !== '') rec[k] = safe(v);
    }
    const arg = toolArg(t, rec.kind);
    if (arg !== undefined) rec.arg = arg;
    const status = typeof t.status === 'string' && t.status !== '' ? safe(t.status) : 'pending';
    const content = Array.isArray(t.content) ? t.content : [];
    const done = DONE_STATUS.has(status);
    // churn: a repeat status never re-prints the header — EXCEPT a
    // terminal repeat that newly carries content: the output card is
    // still owed (it lands once, flagged by rec.body)
    if (rec.status === status || rec.edge === (done ? status : 'live')) {
      if (done && rec.body !== true && content.length > 0) {
        rec.body = true;
        this.tools.set(id, rec);
        this.toolBody(content);
        return;
      }
      rec.status = status;
      this.tools.set(id, rec);
      return;
    }
    rec.status = status;
    rec.edge = done ? status : 'live';
    this.tools.set(id, rec);
    this.toolLine(rec, status);
    if (done && content.length > 0) {
      rec.body = true;
      this.toolBody(content);
    }
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
        this.chunk(u.sessionUpdate, chunkText(u));
        return;
      case 'agent_message_chunk':
        this.chunk('agent_message_chunk', chunkText(u));
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
        // own-key lookup — a '__proto__'/'constructor' kind must land on
        // the fallback, never an inherited Object.prototype member
        (
          (Object.hasOwn(this.structured, u.sessionUpdate)
            ? this.structured[u.sessionUpdate]
            : undefined) ?? (x => this.out(this.dim(`[${safe(x.sessionUpdate)}]`)))
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
