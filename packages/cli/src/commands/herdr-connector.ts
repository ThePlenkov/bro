/**
 * `herdr` connector — the bro-side half of the herdr bridge (spec
 * bro-84zrj). Probes are env-gated: without a herdr-controlled pane
 * (HERDR_PANE_ID + HERDR_SOCKET_PATH) every probe is a no-op, so a cron
 * job, a CI runner, or a bare shell never reaches for the socket.
 *
 * `taskFinish` is the report-back plane: `bro exec` finished a command
 * in this pane — if `agents.herdr.reportBack` enables the pane's agent
 * kind, the connector prompts the pane with the result. That gives an
 * agent kind whose host lacks a task-exit wake (devin) a completion
 * delivery without a watcher agent burning a slot.
 *
 *   "agents": { "herdr": { "reportBack": { "devin": true } } }
 *   "agents": { "herdr": { "reportBack": true } }        // every kind
 *
 * Everything is fire-and-forget through herdr-kit's exec seam (5s
 * fuse, advisory) — a wedged socket retires silently, the watch/poll
 * lanes stay the real delivery.
 */
import type { Connector, ConnectorCtx, TaskFinishReport } from '@broject/core';
import { callAsync, callJsonAsync } from '@broject/herdr-kit';
import { loadAgentEnv } from '../agent-connectors.ts';

/** `herdr agent get <pane>` → `.result.agent` — only the fields this
 *  connector reads. */
export interface PaneAgent {
  agent?: string;
  agent_status?: string;
}

/** `agents.herdr.reportBack` — `true` enables every agent kind, a
 *  `{ <kind>: true }` map opts kinds in one at a time. */
export function reportBackEnabled(reportBack: unknown, kind: string): boolean {
  if (reportBack === true) {
    return true;
  }
  if (typeof reportBack === 'object' && reportBack !== null && !Array.isArray(reportBack)) {
    return (reportBack as Record<string, unknown>)[kind] === true;
  }
  return false;
}

/** One-line digest of a finished command — the prompt payload. */
export function reportBackMessage(report: TaskFinishReport): string {
  const verdict =
    report.exitCode !== null ? `exit ${report.exitCode}` : `signal ${report.signal ?? 'unknown'}`;
  const secs = (report.durationMs / 1000).toFixed(1);
  const tail = report.tail === undefined || report.tail === '' ? '' : `\n\n${report.tail}`;
  return `[task-result] \`bro exec\` ${report.cmd} — ${verdict} (${secs}s)${tail}`;
}

/** Resolved inputs for the report-back decision — the connector fills
 *  them from config and a live `agent get`; tests inject both. */
export interface ReportBackDeps {
  bags?: Record<string, Record<string, unknown>>;
  paneAgent?: () => PaneAgent | undefined | Promise<PaneAgent | undefined>;
}

/** The configured report-back setting — `agents.herdr.reportBack`,
 *  undefined when the config read fails. Split out so the setting is
 *  consulted BEFORE any socket call reaches the pane. */
function reportBackSetting(dir: string, deps: ReportBackDeps): unknown {
  try {
    const bags = deps.bags ?? loadAgentEnv(dir).agents;
    return bags['herdr']?.['reportBack'];
  } catch {
    return undefined;
  }
}

/** The pane's agent kind — undefined when `agent get` cannot answer. */
async function paneKind(pane: string, deps: ReportBackDeps): Promise<string | undefined> {
  const agent = await (
    deps.paneAgent ?? (() => callJsonAsync<PaneAgent>(['agent', 'get', pane]))
  )();
  const kind = agent?.agent;
  return kind === '' ? undefined : kind;
}

/** The env gate — this pane's id when HERDR_PANE_ID and a non-empty
 *  HERDR_SOCKET_PATH are both set, else undefined (the no-op world). */
function herdrPane(env: NodeJS.ProcessEnv): string | undefined {
  const pane = env.HERDR_PANE_ID;
  const socket = env.HERDR_SOCKET_PATH;
  return pane === undefined || pane === '' || socket === undefined || socket === ''
    ? undefined
    : pane;
}

/** The report-back decision, in order — every gate is a silent skip:
 *  not under herdr, report-back not configured for this kind, pane
 *  agent unreadable. The setting is read before `agent get` so a
 *  disabled or absent config never touches the socket; `true` needs
 *  no kind at all — it already enables every agent. Exported so
 *  tests drive the logic without the connector sweep. */
export async function reportBackArgs(
  ctx: ConnectorCtx,
  report: TaskFinishReport,
  env: NodeJS.ProcessEnv = process.env,
  deps: ReportBackDeps = {}
): Promise<string[] | undefined> {
  const pane = herdrPane(env);
  if (pane === undefined) {
    return undefined;
  }
  const setting = reportBackSetting(ctx.dir, deps);
  if (setting === true) {
    return ['agent', 'prompt', pane, reportBackMessage(report)];
  }
  if (setting === undefined || setting === false) {
    return undefined;
  }
  const kind = await paneKind(pane, deps);
  return kind !== undefined && reportBackEnabled(setting, kind)
    ? ['agent', 'prompt', pane, reportBackMessage(report)]
    : undefined;
}

export const herdrConnector: Connector = {
  name: 'herdr',
  hooks: () => ({
    taskFinish: async (ctx, report) => {
      const args = await reportBackArgs(ctx, report);
      if (args !== undefined) {
        await callAsync(args);
      }
    },
  }),
};
