/**
 * `bro herdr status-view <worktree>` — the `bro: status` pane's
 * foreground process (spec bro-idsat). While it occupies the pane,
 * its `bro:fleet`/`bro-status` report authority holds — no heartbeat.
 * It renders the fleet view and self-reports the semantic LED state
 * the daemon projector wrote to the worktree's fleet-state file;
 * on exit it releases, with herdr's ~1s idle-shell probe as the net.
 */
import { mkdirSync, readFileSync, watch } from 'node:fs';
import { basename, dirname } from 'node:path';
import { gitCommonDir } from '@broject/core';
import {
  call,
  metaArgs as kitMetaArgs,
  releaseArgs as kitReleaseArgs,
  reportArgs as kitReportArgs,
  type PaneLed,
  plain,
  STATUS_IDENTITY,
} from '@broject/herdr-kit';
import { type FleetPaneState, fleetStatusPath, nextSeq, parseFleetState } from './fleet-state.ts';

export { PANE_SOURCE, plain } from '@broject/herdr-kit';
export const PANE_AGENT = STATUS_IDENTITY.agent;

/** The report-agent argv for one semantic state (status identity). */
export function reportArgs(pane: string, led: PaneLed, seq: number): string[] {
  return kitReportArgs(pane, led, seq, STATUS_IDENTITY);
}

/** The release argv for pane exit — clears name, state, and any
 *  resume binding so the shell-return probe isn't left to clean up. */
export function releaseArgs(pane: string, seq: number): string[] {
  return kitReleaseArgs(pane, seq, STATUS_IDENTITY);
}

/** The display-text argvs — presentation only: `--display-agent` names
 *  the pane (the agent when the projection resolves one, the slug,
 *  `fleet` last) and `--state-label` swaps the semantic word for the
 *  label's bracket text. Old labels clear each pass so a stale
 *  `working=` can't outlive its state — but herdr rejects
 *  set-and-clear in one call, so clear rides call 1 and the label
 *  lands in call 2. `undefined` state → clear everything back to the
 *  bare `bro-status` binding. */
export function metaArgs(pane: string, s: FleetPaneState | undefined, seq: number): string[][] {
  return kitMetaArgs(
    pane,
    seq,
    STATUS_IDENTITY,
    s?.agent ?? s?.slug ?? 'fleet',
    s !== undefined && s.status !== '' ? `${s.led.state}=${plain(s.status)}` : undefined
  );
}

/** OSC8 hyperlink — `#N` stays `#N` on screen but a ctrl/cmd-click
 *  opens the PR. Wraps only the first `#<digits>` (the PR token);
 *  applied AFTER `plain` since plain strips the escape bytes. */
export function linkifyPr(text: string, prUrl: string | undefined): string {
  if (prUrl === undefined) return text;
  const url = plain(prUrl);
  // http(s) only — a crafted `file:`/`javascript:`/custom-scheme cache
  // entry would open a local handler on click
  if (!/^https?:\/\//i.test(url)) return text;
  return text.replace(/#\d+/, m => `\u001b]8;;${url}\u0007${m}\u001b]8;;\u0007`);
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
  const lines: string[] = [`── ${plain(s?.agent ?? 'fleet')} · ${plain(s?.slug ?? 'waiting')} ──`];
  if (s === undefined) {
    lines.push(' · waiting for the daemon projector', ` ${plain(worktree)}`);
  } else {
    lines.push(
      ` ${LED_ICON[s.led.state]} ${linkifyPr(plain(s.status !== '' ? s.status : s.led.state), s.prUrl)}`,
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
    for (const a of metaArgs(ctx.pane, s, seq)) call(a);
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
