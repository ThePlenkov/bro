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

/** The fixed permission policy (spec): reads (and other observably
 *  non-mutating kinds) may be remembered ALWAYS; everything else is
 *  once-only. A backend that offers no allow-kind option gets a
 *  cancelled outcome — an invented approval is not a viewer's call. */
const ALWAYS_KINDS = new Set(['read', 'search', 'fetch', 'think']);

export interface RenderOpts {
  /** ANSI styling — off for captured/plain output. */
  color?: boolean;
}

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
      ? c.text
      : `[${u.sessionUpdate}: ${c?.type ?? '?'}]`;
  }

  private toolLine(rec: ToolRec, status: string): void {
    const label = rec.title ?? rec.name ?? 'tool';
    const kind = rec.kind !== undefined && rec.kind !== '' ? ` [${rec.kind}]` : '';
    const glyph =
      status === 'completed'
        ? this.paint(GREEN, '⣿')
        : status === 'failed'
          ? this.paint(RED, '⣿')
          : '⣿';
    const word =
      status === 'completed'
        ? this.paint(GREEN, status)
        : status === 'failed'
          ? this.paint(RED, status)
          : this.dim(status);
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
    if (typeof t.title === 'string' && t.title !== '') rec.title = t.title;
    if (typeof t.name === 'string' && t.name !== '') rec.name = t.name;
    if (typeof t.kind === 'string' && t.kind !== '') rec.kind = t.kind;
    const status = typeof t.status === 'string' && t.status !== '' ? t.status : 'pending';
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
      const box =
        e.status === 'completed'
          ? '[x]'
          : e.status === 'in_progress'
            ? '[>]'
            : e.status === 'pending'
              ? '[ ]'
              : '[~]';
      this.out(`  ${box} ${e.content ?? '?'}`);
    }
  }

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
      case 'usage_update': {
        this.flush();
        const t = u as { used?: unknown; size?: unknown };
        this.out(this.dim(`◌ usage ${String(t.used ?? '?')}/${String(t.size ?? '?')}`));
        return;
      }
      case 'config_option_update': {
        this.flush();
        const opts =
          (u['configOptions'] as { id?: string; currentValue?: unknown }[] | undefined) ?? [];
        const kv = opts.map(o => `${o.id}=${String(o.currentValue ?? '?')}`).join(' ');
        this.out(this.dim(`config ${kv}`));
        return;
      }
      case 'current_mode_update': {
        this.flush();
        this.out(
          this.dim(`mode → ${String((u as { currentModeId?: unknown }).currentModeId ?? '?')}`)
        );
        return;
      }
      case 'available_commands_update': {
        this.flush();
        const cmds = (u['availableCommands'] as unknown[] | undefined) ?? [];
        this.out(this.dim(`${cmds.length} commands`));
        return;
      }
      case 'session_info_update': {
        this.flush();
        const title = (u as { title?: unknown }).title;
        this.out(
          this.dim(`session ${typeof title === 'string' && title !== '' ? title : '(info)'}`)
        );
        return;
      }
      case 'subagent_update': {
        this.flush();
        const s = u as { sessionId?: string; title?: string | null; description?: string | null };
        this.out(
          `⎇ subagent ${s.title ?? s.sessionId ?? '?'}${s.description != null && s.description !== '' ? this.dim(` — ${s.description}`) : ''}`
        );
        return;
      }
      default:
        this.flush();
        this.out(this.dim(`[${u.sessionUpdate}]`));
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
        ? `‹${p.channel}› ${p.message}`
        : `[${method}]`;
    this.out(this.dim(text));
  }

  /** `session/request_permission` — render the chip and answer per the
   *  fixed policy; returns the response `outcome` object for the wire. */
  permission(
    params: PermissionRequestLike
  ): { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } {
    this.flush();
    const title = params.toolCall?.title ?? params.toolCall?.toolCallId ?? 'permission request';
    const options = params.options ?? [];
    const names = options.map(o => o.name ?? o.optionId ?? '?').join(', ');
    this.out(`${this.paint(YELLOW, '⚠')} ${title} [${names}]`);
    const readKind = params.toolCall?.kind != null && ALWAYS_KINDS.has(params.toolCall.kind);
    const pick =
      (readKind ? options.find(o => o.kind === 'allow_always') : undefined) ??
      options.find(o => o.kind === 'allow_once') ??
      (readKind ? undefined : options.find(o => o.kind === 'allow_always'));
    if (pick === undefined) {
      this.out(this.dim('  → cancelled — no allow option offered'));
      return { outcome: 'cancelled' };
    }
    const why = readKind ? 'read-kind tool → allow-always' : 'default → allow-once';
    this.out(
      this.dim(
        `  → auto-answered ${pick.name ?? pick.optionId ?? '?'} (${pick.kind ?? '?'}) — policy: ${why}`
      )
    );
    return { outcome: 'selected', optionId: pick.optionId ?? '' };
  }

  /** An agent→client call the watcher does not serve (fs, terminal,
   *  elicitation — unadvertised caps) — visible, then method-not-found. */
  unhandled(method: string): void {
    this.flush();
    this.out(this.dim(`[${method}] — unadvertised, method-not-found`));
  }

  /** Turn boundary — session/prompt resolved with a stop reason. */
  turnEnd(stopReason: string | undefined): void {
    this.flush();
    this.flushNotices();
    this.out(this.dim(`── turn complete (${stopReason ?? 'unknown'}) ──`));
  }

  /** The closing marker — child exit, transport death, or a terminal
   *  turn. The pane keeps its scrollback; only the session is over. */
  closed(detail: string): void {
    this.flush();
    this.flushNotices();
    this.out(this.dim(`── session ended (${detail}) — scrollback kept ──`));
  }

  /** Any trailing buffered chunk lands as its own line. */
  end(): void {
    this.flush();
    this.flushNotices();
  }
}
