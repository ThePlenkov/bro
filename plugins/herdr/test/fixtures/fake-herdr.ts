#!/usr/bin/env node
/**
 * Fake `herdr` CLI for plugin tests. Every invocation appends its argv
 * (as one JSON line) to FAKE_HERDR_LOG so the test can assert calls;
 * answers come from a scenario JSON file (FAKE_HERDR_SCENARIO):
 *
 *   { "panes":    [{ "pane_id": "p1", "label": "bro: events" }],
 *     "paneIds":  ["p1"],                    — panes `pane get` finds
 *     "busyPanes": ["p1"],                   — non-idle foreground
 *     "failSubcommands": ["pane run"],       — exit non-zero
 *     "openWorkspaceId": "wOpened" }
 *
 * Mutations persist across invocations in `<scenario>.state` — a pane
 * `run` marks it busy, `rename`/`split`/`close` update the listing —
 * so a converged pane is seen by the NEXT call, the way the real
 * socket behaves. Anything else answers an empty success envelope —
 * the plugin's herdr surface is fail-open, so a test only scripts
 * what it asserts on.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const logPath = process.env.FAKE_HERDR_LOG;
const args = process.argv.slice(2);
if (logPath !== undefined && logPath !== '') {
  appendFileSync(logPath, `${JSON.stringify(args)}\n`);
}

const scenarioPath = process.env.FAKE_HERDR_SCENARIO ?? '';
const scenario =
  scenarioPath !== '' && existsSync(scenarioPath)
    ? (JSON.parse(readFileSync(scenarioPath, 'utf8')) as Record<string, unknown>)
    : {};

interface Local {
  busy: string[];
  spawned: string[];
  gone: string[];
  labels: Record<string, string>;
  splits: number;
}
const statePath = scenarioPath === '' ? '' : `${scenarioPath}.state`;
const loadLocal = (): Local => {
  try {
    const v = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<Local>;
    return {
      busy: v.busy ?? [],
      spawned: v.spawned ?? [],
      gone: v.gone ?? [],
      labels: v.labels ?? {},
      splits: v.splits ?? 0,
    };
  } catch {
    return { busy: [], spawned: [], gone: [], labels: {}, splits: 0 };
  }
};
const local = loadLocal();
const save = (): void => {
  if (statePath !== '') writeFileSync(statePath, JSON.stringify(local));
};

const busyPanes = new Set([...((scenario.busyPanes ?? []) as string[]), ...local.busy]);
const paneIds = new Set([...((scenario.paneIds ?? []) as string[]), ...local.spawned]);
const livePanes = [
  ...((scenario.panes ?? []) as { pane_id: string; label?: string }[]),
  ...local.spawned.map(pane_id => ({ pane_id })),
].filter(p => !local.gone.includes(p.pane_id));
for (const p of livePanes) {
  if (local.labels[p.pane_id] !== undefined) p.label = local.labels[p.pane_id];
}
const fail = (scenario.failSubcommands ?? []) as string[];
const verb = args.slice(0, 2).join(' ');

const failNow = (): never => {
  console.error('fake-herdr: scripted failure');
  process.exit(1);
};
const out = (result: unknown): void => {
  process.stdout.write(`${JSON.stringify({ result })}\n`);
};

if (fail.includes(verb)) failNow();

if (verb === 'pane list') {
  out({ panes: livePanes });
} else if (verb === 'pane get') {
  const id = args[2] ?? '';
  out(paneIds.has(id) && !local.gone.includes(id) ? { pane: { pane_id: id } } : {});
} else if (verb === 'pane process-info') {
  const id = args[args.indexOf('--pane') + 1] ?? '';
  const shell = 42;
  const fg = busyPanes.has(id) ? [{ pid: shell }, { pid: 99 }] : [{ pid: shell }];
  out({ shell_pid: shell, foreground_processes: fg });
} else if (verb === 'pane split') {
  const id = `pSplit${local.splits++}`;
  local.spawned.push(id);
  save();
  out({ pane: { pane_id: id } });
} else if (verb === 'pane rename') {
  local.labels[args[2] ?? ''] = args[3] ?? '';
  save();
  out({});
} else if (verb === 'pane close') {
  const id = args[2] ?? '';
  local.gone.push(id);
  save();
  out({});
} else if (verb === 'pane run') {
  const id = args[2] ?? '';
  if (!local.busy.includes(id)) local.busy.push(id);
  save();
  // the real verb answers exit-0-and-nothing — success is the code,
  // not an envelope (plugins must use the exit-code path, not herdrTry)
  process.exit(0);
} else if (verb === 'worktree open') {
  const ws = (scenario.openWorkspaceId ?? 'wOpened') as string;
  out({ workspace_id: ws, workspace: { workspace_id: ws } });
} else if (verb === 'workspace close') {
  const id = args[2] ?? args[args.indexOf('close') + 1] ?? '';
  local.gone.push(id);
  save();
  out({});
} else {
  out({});
}
