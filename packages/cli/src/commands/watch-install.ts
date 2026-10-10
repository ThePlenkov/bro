/**
 * `bro watch install|uninstall` — the heartbeat on a non-agent timer
 * (bro-7xgk.5), now a thin spec over the shared scheduler engine in
 * sched.ts (extracted for bro-te73m so `bro rig install` rides the same
 * backends). Entries are per-repo, named `bro-watch-<h8>` where `<h8>`
 * is the git-common-dir's sha256 prefix: each repo's
 * `--once --notify` drops into its own mailbox.
 *
 *   bro watch install [--every N] [--print]   install the poll for this repo
 *   bro watch uninstall                       remove it
 *
 * `--print` emits the artifacts the resolved backend would install
 * (both when no scheduler is detectable) without touching anything.
 */
import {
  cronLine as schedCronLine,
  cronSchedule as schedCronSchedule,
  cronTag as schedCronTag,
  detectBackend as schedDetectBackend,
  installSched,
  printArtifacts as schedPrintArtifacts,
  realRun,
  schedCommonDir,
  schedUnitHash,
  systemdService as schedSystemdService,
  systemdTimer as schedSystemdTimer,
  uninstallSched,
  unitName as schedUnitName,
  type SchedBackend,
  type SchedDeps,
  type SchedInstallResult,
  type SchedRun,
  type SchedRunner,
  type SchedSpec,
} from './sched.ts'
import { cliVersion } from './githooks.ts'

export type { SchedBackend, SchedRun, SchedRunner }
export { realRun }

/** Kept name — the watch-side callers (and older tests) know deps by it. */
export type WatchSchedDeps = SchedDeps

/** The watch poll's scheduler identity — every emitted byte is the
 *  engine's, the spec only names them. */
export const WATCH_SPEC: SchedSpec = {
  prefix: 'bro-watch',
  label: 'bro watch heartbeat',
  hint: 'bro watch install',
  // `bro` on PATH first, the version-pinned npx fallback second (same
  // contract the git-hook shim bakes)
  invocation: (version: string) =>
    `bro watch --once --notify || npx -y --prefer-offline "@broject/bro@${version}" watch --once --notify`,
}

/** The absolute git common dir — units hash on this so a repo's timer
 *  survives a moved checkout and worktrees share one entry. */
export function watchCommonDir(dir: string): string | null {
  return schedCommonDir(dir)
}

export function watchUnitHash(commonDir: string): string {
  return schedUnitHash(commonDir)
}

export const unitName = (commonDir: string): string => schedUnitName(WATCH_SPEC, commonDir)
export const cronTag = (commonDir: string): string => schedCronTag(WATCH_SPEC, commonDir)

/** Type=oneshot service — the scheduler owns the cadence; watch exits
 *  after one snapshot+drop. */
export function systemdService(dir: string, version: string, envPath: string): string {
  return schedSystemdService(WATCH_SPEC, dir, version, envPath)
}

export function systemdTimer(unit: string, everySec: number): string {
  return schedSystemdTimer(WATCH_SPEC, unit, everySec)
}

export function cronSchedule(everySec: number): string {
  return schedCronSchedule(everySec)
}

/** One managed crontab line — the tag is the identity; reinstall
 *  replaces by tag, uninstall strips by tag, foreign lines untouched. */
export function cronLine(
  dir: string,
  everySec: number,
  envPath: string,
  commonDir: string,
  version: string
): string {
  return schedCronLine(WATCH_SPEC, dir, everySec, envPath, commonDir, version)
}

/** systemd user first — a timer survives and needs no babysitting;
 *  crontab is the portable floor; null when neither answers. */
export function detectBackend(run: SchedRunner): SchedBackend | null {
  return schedDetectBackend(run)
}

/** Artifacts for --print (and the install-nowhere guidance). */
export function printArtifacts(
  dir: string,
  everySec: number,
  version: string,
  deps: WatchSchedDeps
): string | { error: string } {
  return schedPrintArtifacts(WATCH_SPEC, dir, everySec, version, deps)
}

export type WatchInstallResult = SchedInstallResult

export function installWatch(
  dir: string,
  opts: { everySec: number; print?: boolean },
  deps: WatchSchedDeps = {}
): WatchInstallResult {
  return installSched(WATCH_SPEC, dir, cliVersion(), opts, deps)
}

export function uninstallWatch(dir: string, deps: WatchSchedDeps = {}): WatchInstallResult {
  return uninstallSched(WATCH_SPEC, dir, deps)
}
