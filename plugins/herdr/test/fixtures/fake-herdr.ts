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
 * Anything else answers an empty success envelope — the plugin's herdr
 * surface is fail-open, so a test only scripts what it asserts on.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

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

const panes = (scenario.panes ?? []) as { pane_id: string; label?: string }[];
const paneIds = new Set((scenario.paneIds ?? []) as string[]);
const busyPanes = new Set((scenario.busyPanes ?? []) as string[]);
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

let splitSeq = 0;
if (logPath !== undefined && logPath !== '' && existsSync(logPath)) {
  splitSeq = readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(l => l.includes('"split"')).length;
}

if (verb === 'pane list') {
  out({ panes });
} else if (verb === 'pane get') {
  const id = args[2] ?? '';
  out(paneIds.has(id) ? { pane: { pane_id: id } } : {});
} else if (verb === 'pane process-info') {
  const id = args[args.indexOf('--pane') + 1] ?? '';
  const shell = 42;
  const fg = busyPanes.has(id) ? [{ pid: shell }, { pid: 99 }] : [{ pid: shell }];
  out({ shell_pid: shell, foreground_processes: fg });
} else if (verb === 'pane split') {
  out({ pane: { pane_id: `pSplit${splitSeq}` } });
} else if (verb === 'pane run') {
  // the real verb answers exit-0-and-nothing — success is the code,
  // not an envelope (plugins must use the exit-code path, not herdrTry)
  process.exit(0);
} else if (verb === 'worktree open') {
  const ws = (scenario.openWorkspaceId ?? 'wOpened') as string;
  out({ workspace_id: ws, workspace: { workspace_id: ws } });
} else {
  out({});
}
