/**
 * `bro herdr status-view <worktree>` — the `bro: status` pane's
 * foreground process (spec bro-idsat). While it occupies the pane,
 * its `bro:fleet`/`bro-status` report authority holds — no heartbeat.
 * It renders the fleet view and self-reports the semantic LED state
 * the daemon projector wrote to the worktree's fleet-state file;
 * on exit it releases, with herdr's ~1s idle-shell probe as the net.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, watch } from 'node:fs';
import { basename, dirname } from 'node:path';
import { gitCommonDir } from '@broject/core';
import {
  type FleetPaneState,
  fleetStatusPath,
  nextSeq,
  type PaneLed,
  parseFleetState,
} from './fleet-state.ts';

export const PANE_SOURCE = 'bro:fleet';
export const PANE_AGENT = 'bro-status';

/** Milliseconds — every herdr call is fire-and-forget behind a short
 *  fuse; a wedged socket must not freeze the view. */
const HERDR_TIMEOUT_MS = 5_000;

const herdrBin = (): string => process.env.HERDR_BIN_PATH ?? 'herdr';

function call(args: string[]): void {
  try {
    spawnSync(herdrBin(), args, { timeout: HERDR_TIMEOUT_MS, stdio: 'ignore' });
  } catch {
    // every report is advisory — a dead socket retires to the watch loop
  }
}

/** The shared report/release/metadata envelope — `bro:fleet` (never
 *  `herdr:`-reserved), `bro-status` (self-reported, unrecognized by
 *  design), unix-micros seq. */
function paneArgs(verb: string, pane: string, seq: number): string[] {
  return ['pane', verb, pane, '--source', PANE_SOURCE, '--agent', PANE_AGENT, '--seq', String(seq)];
}

/** The report-agent argv for one semantic state. */
export function reportArgs(pane: string, led: PaneLed, seq: number): string[] {
  const args = [...paneArgs('report-agent', pane, seq), '--state', led.state];
  if (led.message !== undefined && led.message !== '') {
    args.push('--message', led.message);
  }
  return args;
}

/** The release argv for pane exit — clears name, state, and any
 *  resume binding so the shell-return probe isn't left to clean up. */
export function releaseArgs(pane: string, seq: number): string[] {
  return paneArgs('release-agent', pane, seq);
}

/** Strip C0/C1 control bytes from untrusted text — a bead title is
 *  operator input, and an embedded ESC written to the pane is terminal
 *  injection (clear-screen, title-set, worse). */
export function plain(s: string): string {
  // eslint-disable-next-line no-control-regex -- sanitizing is the point
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}

/** The display-text argv — presentation only: `--display-agent` names
 *  the pane (the slug when the projection has one, `fleet` otherwise)
 *  and `--state-label` swaps the semantic word for the label's bracket
 *  text. Old labels clear each pass so a stale `working=` can't outlive
 *  its state. `undefined` state → clear everything back to the bare
 *  `bro-status` binding. */
export function metaArgs(pane: string, s: FleetPaneState | undefined, seq: number): string[] {
  const args = [
    ...paneArgs('report-metadata', pane, seq),
    '--display-agent',
    plain(s?.slug ?? 'fleet'),
    '--clear-state-labels',
  ];
  if (s !== undefined && s.status !== '') {
    args.push('--state-label', `${s.led.state}=${plain(s.status)}`);
  }
  return args;
}

const LED_ICON: Record<PaneLed['state'], string> = {
  working: '●',
  blocked: '×',
  idle: '✓',
  unknown: '·',
};

/** The pane's visible face — a compact redraw of the projection. `s`
 *  undefined is the waiting state: the projector hasn't written yet
 *  (daemon down, first pass pending). */
export function renderView(
  s: FleetPaneState | undefined,
  worktree: string,
  now = Date.now()
): string {
  const lines: string[] = [`── bro fleet · ${plain(s?.slug ?? 'waiting')} ──`];
  if (s === undefined) {
    lines.push(' · waiting for the daemon projector', ` ${plain(worktree)}`);
  } else {
    lines.push(
      ` ${LED_ICON[s.led.state]} ${plain(s.status !== '' ? s.status : s.led.state)}`,
      ` ${plain(s.title)}`,
      ` ${plain(worktree)} · ${plain(s.workspace)}`,
      ` updated ${new Date(s.ts).toTimeString().slice(0, 8)} (${Math.max(0, Math.round((now - s.ts) / 1000))}s ago)`
    );
  }
  return `\u001b[2J\u001b[H${lines.join('\n')}\n`;
}

/** Re-read + apply when the file content actually moved — the dedupe
 *  that keeps fs.watch bursts and safety polls quiet. `lastRaw` of
 *  `null` means "never applied" — an absent file still binds
 *  `unknown` on the first refresh. Returns the raw the caller should
 *  compare next. */
export function applyRaw(
  raw: string | undefined,
  lastRaw: string | undefined | null,
  apply: (s: FleetPaneState | undefined) => void
): string | undefined {
  if (raw === lastRaw) return lastRaw;
  apply(raw === undefined ? undefined : parseFleetState(raw));
  return raw;
}

function readRaw(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** Wire the exit-time release — one `release-agent` for every way
 *  out (signals route through the exit handler). Idempotent: the
 *  first release wins. */
function armRelease(pane: string): void {
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    call(releaseArgs(pane, nextSeq()));
  };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => process.exit(0));
  }
}

/** Everything one live view needs — resolved once at start. */
interface ViewCtx {
  worktree: string;
  pane: string;
  statePath: string;
}

/** Arg + environment resolution — `undefined` means "outside herdr,
 *  do nothing" (the add-herdr-support contract); a missing worktree
 *  arg is the only usage error. */
function viewContext(argv: string[]): ViewCtx | undefined {
  const worktree = argv.find(a => !a.startsWith('-'));
  if (worktree === undefined) {
    console.error('usage: bro herdr status-view <worktree> [--once]');
    process.exit(2);
  }
  if (process.env.HERDR_ENV !== '1') return undefined;
  const pane = process.env.HERDR_PANE_ID;
  if (pane === undefined || pane === '') return undefined;
  const base = gitCommonDir(worktree) ?? worktree;
  return { worktree, pane, statePath: fleetStatusPath(base, worktree) };
}

/** One deduped re-read — parses, reports, redraws only on real moves. */
function makeRefresh(ctx: ViewCtx): () => void {
  let lastRaw: string | undefined | null = null;
  const apply = (s: FleetPaneState | undefined): void => {
    const seq = nextSeq();
    call(reportArgs(ctx.pane, s?.led ?? { state: 'unknown' }, seq));
    call(metaArgs(ctx.pane, s, seq));
    process.stdout.write(renderView(s, ctx.worktree));
  };
  return () => {
    lastRaw = applyRaw(readRaw(ctx.statePath), lastRaw, apply);
  };
}

/** dir watch, not file watch — the projector swaps via rename, so the
 *  file's inode changes every write; the parent dir sees every swap. */
function armWatch(ctx: ViewCtx, refresh: () => void): void {
  try {
    watch(dirname(ctx.statePath), (_e, name) => {
      if (name === basename(ctx.statePath)) refresh();
    });
  } catch {
    // the dir vanishes only with the whole repo — the poll below still rides
  }
}

/** `bro herdr status-view <worktree> [--once]` — the pane's whole
 *  lifecycle: bind `unknown`, ride file changes, release on exit. */
export async function runStatusView(argv: string[]): Promise<void> {
  const ctx = viewContext(argv);
  if (ctx === undefined) return;
  mkdirSync(dirname(ctx.statePath), { recursive: true });
  armRelease(ctx.pane);

  const refresh = makeRefresh(ctx);
  refresh();
  if (argv.includes('--once')) return;

  armWatch(ctx, refresh);
  // the interval is the stay-alive handle AND the safety net — a ref'd
  // timer keeps the pane occupied even when the watch failed to arm
  setInterval(refresh, 30_000);
  await new Promise(() => {});
}
