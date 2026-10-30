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

/** The report-agent argv for one semantic state — `bro:fleet` (never
 *  `herdr:`-reserved), `bro-status` (self-reported, unrecognized by
 *  design), unix-nanos seq. */
export function reportArgs(pane: string, led: PaneLed, seq: number): string[] {
  const args = [
    'pane',
    'report-agent',
    pane,
    '--source',
    PANE_SOURCE,
    '--agent',
    PANE_AGENT,
    '--seq',
    String(seq),
    '--state',
    led.state,
  ];
  if (led.message !== undefined && led.message !== '') {
    args.push('--message', led.message);
  }
  return args;
}

/** The release argv for pane exit — clears name, state, and any
 *  resume binding so the shell-return probe isn't left to clean up. */
export function releaseArgs(pane: string, seq: number): string[] {
  return [
    'pane',
    'release-agent',
    pane,
    '--source',
    PANE_SOURCE,
    '--agent',
    PANE_AGENT,
    '--seq',
    String(seq),
  ];
}

/** The display-text argv — presentation only: `--display-agent` names
 *  the pane (the slug when the projection has one, `fleet` otherwise)
 *  and `--state-label` swaps the semantic word for the label's bracket
 *  text. Old labels clear each pass so a stale `working=` can't outlive
 *  its state. `undefined` state → clear everything back to the bare
 *  `bro-status` binding. */
export function metaArgs(pane: string, s: FleetPaneState | undefined, seq: number): string[] {
  const args = [
    'pane',
    'report-metadata',
    pane,
    '--source',
    PANE_SOURCE,
    '--agent',
    PANE_AGENT,
    '--seq',
    String(seq),
    '--display-agent',
    s?.slug ?? 'fleet',
    '--clear-state-labels',
  ];
  if (s !== undefined && s.status !== '') {
    args.push('--state-label', `${s.led.state}=${s.status}`);
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
  const lines: string[] = [`── bro fleet · ${s?.slug ?? 'waiting'} ──`];
  if (s === undefined) {
    lines.push(' · waiting for the daemon projector', ` ${worktree}`);
  } else {
    lines.push(
      ` ${LED_ICON[s.led.state]} ${s.status !== '' ? s.status : s.led.state}`,
      ` ${s.title}`,
      ` ${worktree} · ${s.workspace}`,
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

/** `bro herdr status-view <worktree> [--once]` — the pane's whole
 *  lifecycle: bind `unknown`, ride file changes, release on exit. */
export async function runStatusView(argv: string[]): Promise<void> {
  const args = argv.filter(a => a !== '--once');
  const once = argv.includes('--once');
  const worktree = args[0];
  if (worktree === undefined || worktree.startsWith('-')) {
    console.error('usage: bro herdr status-view <worktree> [--once]');
    process.exit(2);
  }
  const pane = process.env.HERDR_PANE_ID;
  if (process.env.HERDR_ENV !== '1' || pane === undefined || pane === '') {
    // the add-herdr-support contract — outside Herdr do nothing
    return;
  }

  const base = gitCommonDir(worktree) ?? worktree;
  const statePath = fleetStatusPath(base, worktree);
  mkdirSync(dirname(statePath), { recursive: true });

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    call(releaseArgs(pane, nextSeq()));
  };
  // the exit event covers signals, normal returns, and fatal throws —
  // one release for every way out
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => process.exit(0));
  }

  const apply = (s: FleetPaneState | undefined): void => {
    const seq = nextSeq();
    call(reportArgs(pane, s?.led ?? { state: 'unknown' }, seq));
    call(metaArgs(pane, s, seq));
    process.stdout.write(renderView(s, worktree));
  };

  let lastRaw: string | undefined | null = null;
  const refresh = (): void => {
    lastRaw = applyRaw(readRaw(statePath), lastRaw, apply);
  };

  refresh();
  if (once) return;

  // dir watch, not file watch — the projector swaps via rename, so the
  // file's inode changes every write; the parent dir sees every swap.
  try {
    watch(dirname(statePath), (_e, name) => {
      if (name === basename(statePath)) refresh();
    });
  } catch {
    // the dir vanishes only with the whole repo — the poll below still rides
  }
  // the interval is the stay-alive handle AND the safety net — a ref'd
  // timer keeps the pane occupied even when the watch failed to arm
  setInterval(refresh, 30_000);
  await new Promise(() => {});
}
