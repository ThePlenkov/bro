/**
 * `bro mode` — per-session behaviour mode (specs/bro-izpyk.2.md; epic
 * specs/sessions/bro-izpyk.md). One mode per (host, nativeSessionId):
 *
 *   observe      passive — ledger/spool keep recording, inbox delivery
 *                stays on; no rehydration, no gates, no active probes
 *   plan         rehydration + ready tasks + specs/plan context
 *   code         today's full interactive behavior
 *   review       act gate, threads and PR context
 *   orchestrate  supervisor duties on top of code
 *
 *   bro mode                              this session's effective mode
 *   bro mode <mode|off>                   set it ('off' pins observe)
 *   bro mode list [--json]                every mode file + ledger session
 *   bro mode clear                        remove the file → modes.default
 *   bro mode render [--mode <m>]          re-render Tier-1 snapshots
 *
 * Mode files under `$XDG_STATE_HOME/bro/sessions/<host>-<sid>.mode` are
 * the hook-time truth — hooks/run.sh reads them before paying Node, and
 * hooks.js resolves the same file for connector `activeIn` gating. A
 * missing file resolves `modes.default` (bro.config `modes.default`)
 * then `observe`; `bro mode` also writes `LedgerFacade.setMode` so the
 * F1 ledger column stays a faithful projection.
 *
 * Session resolution: --session/--host flags win; otherwise the session
 * env ids and the plugin-root/project-dir host detection the hook spool
 * uses. `bro mode <name>` inside an agent shell that cannot see session
 * env still works — the post-tool hook binds the command to the calling
 * session (parseModeCommand), so the CLI prints the binding path and
 * exits 0 rather than failing the tool call.
 */
import {
  CommandError,
  EXIT,
  facade,
  hasHelpFlag,
  hookHostOf,
  isMode,
  listModeFiles,
  loadConfig,
  modeFilePath,
  MODES,
  printUsage,
  removeModeFile,
  sessionIdFromEnv,
  sessionMode,
  sessionProject,
  writeModeFile,
  type LedgerFacade,
  type Mode,
  type SessionRow,
} from '@broject/core';
import { flag, positionals } from './args.ts';
import { loadBroConfig } from '../plugins.ts';
import { renderModeSnapshots, SNAPSHOT_MODES } from './mode-snapshots.ts';

const USAGE = `usage: bro mode [get] [--session <sid>] [--host <h>] [--json]
       bro mode <${MODES.join('|')}|off> [--session <sid>] [--host <h>]
       bro mode list [--json]
       bro mode clear [--session <sid>] [--host <h>]
       bro mode render [--mode <m>]

  get      effective mode + resolution source — the default
  set      write the mode file + ledger projection; 'off' pins observe
           so modes.default cannot re-activate the session
  list     mode files on disk ∪ ledger sessions (file mode wins)
  clear    remove the mode file — the session falls back to
           modes.default / observe
  render   re-render Tier-1 snapshots for this project

Mode files live at $XDG_STATE_HOME/bro/sessions/<host>-<sid>.mode;
missing resolves modes.default (bro.config "modes") then observe.`;

export interface ModeArgs {
  sub: 'get' | 'set' | 'list' | 'clear' | 'render';
  mode?: Mode;
  session?: string;
  host?: string;
  renderMode?: Mode;
  json: boolean;
}

const SUBS = new Set(['get', 'list', 'clear', 'render']);

/** Parsed `bro mode` argv — strict positionals; the first positional is
 *  a subcommand or a mode name. `off` normalizes to `observe` at parse
 *  (it is the explicit pin, not a seventh mode). */
export function modeArgs(argv: string[]): ModeArgs {
  const rest = positionals(argv, new Set(['--session', '--host', '--mode']), {
    boolFlags: new Set(['--json']),
    strict: true,
  });
  if (rest.length > 1) {
    throw new CommandError(`error: unexpected argument "${rest[1]}"\n${USAGE}`, EXIT.usage);
  }
  const first = rest[0];
  const session = flag(argv, '--session');
  const host = flag(argv, '--host');
  const renderModeRaw = flag(argv, '--mode');
  const json = argv.includes('--json');
  if (session !== undefined && session.trim() === '') {
    throw new CommandError('error: --session requires a non-empty value', EXIT.usage);
  }
  if (host !== undefined && host.trim() === '') {
    throw new CommandError('error: --host requires a non-empty value', EXIT.usage);
  }
  let renderMode: Mode | undefined;
  if (renderModeRaw !== undefined) {
    if (!isMode(renderModeRaw)) {
      throw new CommandError(
        `error: --mode must be one of ${MODES.join('|')} — got ${JSON.stringify(renderModeRaw)}\n${USAGE}`,
        EXIT.usage
      );
    }
    renderMode = renderModeRaw;
  }
  if (first === undefined || first === 'get') {
    if (renderMode !== undefined) {
      throw new CommandError('error: --mode only applies to `bro mode render`', EXIT.usage);
    }
    return { sub: 'get', session, host, json };
  }
  if (SUBS.has(first)) {
    const sub = first as 'list' | 'clear' | 'render';
    if (sub !== 'render' && renderMode !== undefined) {
      throw new CommandError(`error: --mode only applies to \`bro mode render\``, EXIT.usage);
    }
    if (sub === 'render' && session !== undefined) {
      throw new CommandError(
        'error: render takes no session — it renders per project+mode',
        EXIT.usage
      );
    }
    return { sub, session, host, renderMode, json };
  }
  // a mode name (or 'off') — set
  const mode = first === 'off' ? 'observe' : first;
  if (!isMode(mode)) {
    throw new CommandError(
      `error: unknown mode "${first}" — expected ${MODES.join('|')} or off\n${USAGE}`,
      EXIT.usage
    );
  }
  if (renderMode !== undefined) {
    throw new CommandError('error: --mode only applies to `bro mode render`', EXIT.usage);
  }
  return { sub: 'set', mode, session, host, json };
}

export interface ModeDeps {
  dir?: string;
  env?: NodeJS.ProcessEnv;
  ledger?: LedgerFacade;
  /** Test seam — snapshot rendering is otherwise real (probes + fs). */
  render?: (dir: string, mode: Mode) => Promise<unknown>;
}

interface ResolvedSession {
  host: string;
  sid: string;
  /** True when resolution came from env/flags rather than failing. */
  ok: boolean;
}

/** --session/--host flags win; else env session id + env host detect.
 *  `ok:false` = no session id resolvable — callers decide whether that
 *  is an error (get/clear) or the hook-binding path (set). */
function resolveSession(
  args: Pick<ModeArgs, 'session' | 'host'>,
  env: NodeJS.ProcessEnv
): ResolvedSession {
  const sid = args.session ?? sessionIdFromEnv(env);
  if (sid === undefined || sid.trim() === '') {
    return { host: args.host ?? hookHostOf(env), sid: '', ok: false };
  }
  return { host: args.host ?? hookHostOf(env), sid: sid.trim(), ok: true };
}

/** `modes.default` from the merged config — undefined when unset (the
 *  section is absent-by-default so observe stays implicit). */
function modesDefault(dir: string): Mode | undefined {
  try {
    const d = loadConfig(dir).modes?.default;
    return isMode(d) ? d : undefined;
  } catch {
    return undefined;
  }
}

function modeLedger(dir: string, deps: ModeDeps): LedgerFacade {
  if (deps.ledger !== undefined) {
    return deps.ledger;
  }
  const prefer = loadBroConfig(dir).connectors;
  return facade('ledger', { dir }, prefer === undefined ? {} : { prefer });
}

async function ledgerSetMode(
  ledger: LedgerFacade | undefined,
  host: string,
  sid: string,
  mode: Mode,
  warnings: string[]
): Promise<void> {
  if (ledger === undefined) {
    return;
  }
  try {
    await ledger.setMode({ host, sid }, mode);
  } catch (err) {
    warnings.push(
      `ledger setMode failed — the mode file still stands (${err instanceof Error ? err.message : String(err)})`
    );
  }
}

function modeJson(sess: ResolvedSession & { mode: Mode; source: string; file: string | null }) {
  return {
    host: sess.host,
    sid: sess.sid,
    mode: sess.mode,
    source: sess.source,
    file: sess.file,
  };
}

async function runGet(
  args: ModeArgs,
  sess: ResolvedSession,
  dir: string,
  env: NodeJS.ProcessEnv,
  warnings: string[]
): Promise<void> {
  const res = sessionMode({ env, host: sess.host, sid: sess.sid, defaultMode: modesDefault(dir) });
  if (args.json) {
    console.log(JSON.stringify({ session: modeJson({ ...sess, ...res }), warnings }, null, 2));
    return;
  }
  const key = `${sess.host}-${sess.sid}`;
  if (res.file !== null && res.source === 'file') {
    console.log(`session ${key} mode: ${res.mode} (mode file)`);
  } else if (res.source === 'default') {
    console.log(`session ${key} mode: ${res.mode} (modes.default — no mode file)`);
  } else {
    console.log(`session ${key} mode: observe (default — no mode file)`);
  }
  for (const w of warnings) {
    console.error(`warning: ${w}`);
  }
}

async function runSet(
  args: ModeArgs & { mode: Mode },
  sess: ResolvedSession,
  dir: string,
  env: NodeJS.ProcessEnv,
  ledger: LedgerFacade | undefined,
  render: (dir: string, mode: Mode) => Promise<unknown>
): Promise<void> {
  const file = modeFilePath(env, sess.host, sess.sid);
  if (file === null) {
    throw new CommandError('error: no state dir resolves — cannot write a mode file', EXIT.error);
  }
  const project = sessionProject(dir);
  writeModeFile(file, args.mode, project);
  const warnings: string[] = [];
  await ledgerSetMode(ledger, sess.host, sess.sid, args.mode, warnings);
  // Tier-1 snapshots render for the mode just set — the next
  // session-start/post-compaction reads them instead of the live sweep.
  // Best-effort: a probe failure leaves the live path answering.
  if (project !== undefined && args.mode !== 'observe') {
    try {
      await render(dir, args.mode);
    } catch {
      // render is best-effort — snapshots are an optimization
    }
  }
  if (args.json) {
    console.log(
      JSON.stringify(
        {
          session: modeJson({ ...sess, mode: args.mode, source: 'file', file }),
          warnings,
        },
        null,
        2
      )
    );
    return;
  }
  console.log(`session ${sess.host}-${sess.sid} mode: ${args.mode} (mode file ${file})`);
  for (const w of warnings) {
    console.error(`warning: ${w}`);
  }
}

async function runClear(
  args: ModeArgs,
  sess: ResolvedSession,
  dir: string,
  env: NodeJS.ProcessEnv,
  ledger: LedgerFacade | undefined
): Promise<void> {
  const file = modeFilePath(env, sess.host, sess.sid);
  if (file !== null) {
    removeModeFile(file);
  }
  // the ledger projection follows the post-clear effective mode —
  // modes.default may re-activate the session
  const res = sessionMode({
    env,
    host: sess.host,
    sid: sess.sid,
    defaultMode: modesDefault(dir),
  });
  const warnings: string[] = [];
  await ledgerSetMode(ledger, sess.host, sess.sid, res.mode, warnings);
  if (args.json) {
    console.log(
      JSON.stringify(
        { session: modeJson({ ...sess, ...res, file: file ?? null }), warnings },
        null,
        2
      )
    );
    return;
  }
  console.log(
    `session ${sess.host}-${sess.sid} mode file cleared — effective mode: ${res.mode} (${res.source})`
  );
  for (const w of warnings) {
    console.error(`warning: ${w}`);
  }
}

interface ModeListRow {
  host: string;
  sid: string;
  mode: Mode;
  source: 'file' | 'ledger';
  /** epoch ms — file mtime or ledger lastSeen. */
  seen: number;
  file?: string;
}

/** Mode files ∪ ledger sessions — the file's mode wins for sessions
 *  that have one (it is the hook-time truth); ledger-only rows show
 *  their stored projection. Join key is the sanitized stem both sides
 *  share. */
async function collectModeRows(
  env: NodeJS.ProcessEnv,
  ledger: LedgerFacade | undefined,
  warnings: string[]
): Promise<ModeListRow[]> {
  const files = listModeFiles(env);
  const rows = new Map<string, ModeListRow>();
  for (const f of files) {
    const key = `${f.host}-${f.sid}`;
    rows.set(key, {
      host: f.host,
      sid: f.sid,
      // a corrupt file resolves observe — listed as such with its raw
      // line kept out of the mode column (source stays honest)
      mode: f.mode ?? 'observe',
      source: 'file',
      seen: f.mtimeMs,
      file: f.path,
    });
  }
  if (ledger !== undefined) {
    let stored: SessionRow[];
    try {
      stored = await ledger.sessions({});
    } catch (err) {
      warnings.push(
        `ledger sessions unavailable — file modes only (${err instanceof Error ? err.message : String(err)})`
      );
      stored = [];
    }
    for (const s of stored) {
      const stemHost = s.host;
      const stemSid = s.sid.replace(/[^A-Za-z0-9_.-]/g, '_');
      const key = `${stemHost}-${stemSid}`;
      if (rows.has(key)) {
        continue; // file wins
      }
      rows.set(key, {
        host: s.host,
        sid: s.sid,
        mode: s.mode,
        source: 'ledger',
        seen: s.lastSeen,
      });
    }
  }
  return [...rows.values()].sort((a, b) => b.seen - a.seen);
}

function modeTableLines(rows: ModeListRow[]): string[] {
  const cols: [keyof ModeListRow, string][] = [
    ['host', 'HOST'],
    ['sid', 'SID'],
    ['mode', 'MODE'],
    ['source', 'SOURCE'],
    ['seen', 'SEEN'],
  ];
  const cell = (r: ModeListRow, k: string): string => {
    if (k === 'sid') {
      return r.sid.length > 16 ? `${r.sid.slice(0, 16)}…` : r.sid;
    }
    if (k === 'seen') {
      const s = Math.max(0, Math.floor((Date.now() - r.seen) / 1000));
      if (s < 60) return `${s}s`;
      const m = Math.floor(s / 60);
      if (m < 60) return `${m}m`;
      const h = Math.floor(m / 60);
      if (h < 48) return `${h}h`;
      return `${Math.floor(h / 24)}d`;
    }
    const v = r[k as keyof ModeListRow];
    return v === null || v === undefined || v === '' ? '—' : String(v);
  };
  const cells = rows.map(r => cols.map(([k]) => cell(r, k)));
  const widths = cols.map(([, h], i) => Math.max(h.length, ...cells.map(c => c[i]!.length)));
  const line = (vals: string[]) =>
    vals
      .map((v, i) => v.padEnd(widths[i]!))
      .join('  ')
      .trimEnd();
  return [line(cols.map(([, h]) => h)), ...cells.map(c => line(c))];
}

async function runList(
  args: ModeArgs,
  env: NodeJS.ProcessEnv,
  ledger: LedgerFacade | undefined
): Promise<void> {
  const warnings: string[] = [];
  const rows = await collectModeRows(env, ledger, warnings);
  if (args.json) {
    console.log(JSON.stringify({ modes: rows, warnings }, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log('no session modes — every session resolves observe');
  } else {
    for (const line of modeTableLines(rows)) {
      console.log(line);
    }
  }
  for (const w of warnings) {
    console.error(`warning: ${w}`);
  }
}

async function runRender(
  args: ModeArgs,
  dir: string,
  render: (dir: string, mode: Mode) => Promise<unknown>
): Promise<void> {
  const modes = args.renderMode !== undefined ? [args.renderMode] : [...SNAPSHOT_MODES];
  const project = sessionProject(dir);
  if (project === undefined) {
    if (args.json) {
      console.log(JSON.stringify({ rendered: [], warnings: ['project unresolvable'] }, null, 2));
    } else {
      console.log('project unresolvable — snapshots need a git project id');
    }
    return;
  }
  const rendered: string[] = [];
  const warnings: string[] = [];
  for (const mode of modes) {
    try {
      await render(dir, mode);
      rendered.push(mode);
    } catch (err) {
      warnings.push(`render ${mode} failed (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  if (args.json) {
    console.log(JSON.stringify({ project, rendered, warnings }, null, 2));
    return;
  }
  console.log(
    rendered.length === 0
      ? 'no snapshots rendered'
      : `snapshots rendered for ${project}: ${rendered.join(', ')}`
  );
  for (const w of warnings) {
    console.error(`warning: ${w}`);
  }
}

export async function runModeCommand(argv: string[], deps: ModeDeps = {}): Promise<void> {
  if (hasHelpFlag(argv)) {
    printUsage(USAGE, EXIT.ok);
  }
  const args = modeArgs(argv);
  const dir = deps.dir ?? process.cwd();
  const env = deps.env ?? process.env;
  const render = deps.render ?? ((d: string, m: Mode) => renderModeSnapshots(d, m, env));

  if (args.sub === 'list') {
    await runList(args, env, modeLedger(dir, deps));
    return;
  }
  if (args.sub === 'render') {
    await runRender(args, dir, render);
    return;
  }

  const sess = resolveSession(args, env);
  if (!sess.ok) {
    if (args.sub === 'set' && args.mode !== undefined) {
      // the agent-shell path — the post-tool hook binds `bro mode
      // <name>` to this session on the same tool call; failing here
      // would break the command the hook is watching for
      console.error(
        `no session id in env — if this ran inside an agent session, the post-tool hook binds '${args.mode}' automatically; otherwise re-run with --session <id> --host <h>`
      );
      return;
    }
    throw new CommandError(
      `error: no session id resolvable — pass --session <id> [--host <h>] or run inside an agent session\n${USAGE}`,
      EXIT.usage
    );
  }

  if (args.sub === 'get') {
    await runGet(args, sess, dir, env, []);
    return;
  }
  if (args.sub === 'set' && args.mode !== undefined) {
    await runSet({ ...args, mode: args.mode }, sess, dir, env, modeLedger(dir, deps), render);
    return;
  }
  if (args.sub === 'clear') {
    await runClear(args, sess, dir, env, modeLedger(dir, deps));
    return;
  }
  throw new CommandError(`error: unhandled mode subcommand\n${USAGE}`, EXIT.usage);
}
