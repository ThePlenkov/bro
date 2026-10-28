/**
 * Action `acp:watch` — open a pane running the readonly ACP session
 * renderer (spec bro-5vjpg). Splits a pane under the invocation's
 * focused pane and runs `acp-watch.ts` in it: the pane spawns and owns
 * its ACP session (`--cmd`, default `devin acp`; `--prompt` seeds one
 * turn).
 *
 * Params come from SELECTED TEXT (herdr action invocation carries no
 * argv channel — `plugin.action.invoke` context is the only param
 * plane):
 *
 *   select `--prompt "summarize this repo"`            → prompt
 *   select `--cmd 'kilo acp' --prompt '…'`             → cmd + prompt
 *   select `summarize this repo` (bare text)          → prompt
 *   nothing selected                                  → watch only
 *
 * `--cmd`'s fallback is the plugin config's `acp_cmd` key, then the
 * spec default `devin acp`. The pane is a normal shell pane — the
 * renderer exits, the shell stays, scrollback survives.
 */
import { basename, join } from 'node:path';
import {
  PLUGIN_ROOT,
  configValue,
  ctxJson,
  herdrTry,
  notify,
  paneIdle,
  paneList,
  repoDir,
  shellWords,
  shq,
} from './lib.ts';

const ctx = ctxJson();
const repo = repoDir(ctx);
// ctx shape hedges: pane-run invocations deliver nested objects, the
// socket API delivers flat *_id/*_cwd keys — read both, env last
const cwd =
  ctx.worktree?.checkout_path ??
  ctx.focused_pane?.cwd ??
  ctx.focused_pane_cwd ??
  ctx.workspace_cwd ??
  repo;
const ws = ctx.workspace?.workspace_id ?? ctx.workspace_id ?? process.env.HERDR_WORKSPACE_ID;
const wsPanes = ws === undefined ? [] : paneList(ws);
const target =
  ctx.focused_pane?.pane_id ??
  ctx.pane?.pane_id ??
  ctx.focused_pane_id ??
  process.env.HERDR_PANE_ID ??
  wsPanes.find(p => paneIdle(p.pane_id))?.pane_id ??
  wsPanes[0]?.pane_id;
if (target === undefined) {
  console.error('acp:watch — no pane to split (invoke from a workspace with a pane)');
  process.exit(1);
}

// one acp pane per workspace — a re-invoke REPLACES the watcher, it
// never stacks. The label is our own marker (`acp: <cmd basename>`
// set by pane rename below).
const LABEL = 'acp: ';
const stale = wsPanes.filter(p => p.label?.startsWith(LABEL));
for (const p of stale) herdrTry(['pane', 'close', p.pane_id]);

// selected text → --cmd/--prompt; bare text is the prompt
let cmd = configValue('acp_cmd', 'devin acp');
let prompt: string | undefined;
const sel = (ctx.selected_text ?? '').trim();
if (sel !== '') {
  const words = sel.startsWith('-') ? shellWords(sel) : [sel];
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as string;
    if (w === '--cmd' || w === '--prompt') {
      const v = words[++i];
      if (v === undefined) {
        console.error(`acp:watch — ${w} needs a value in the selected text`);
        process.exit(1);
      }
      if (w === '--cmd') cmd = v;
      else prompt = v;
    } else {
      // a bare word in a flagged selection still reads as the prompt
      prompt = prompt === undefined ? w : `${prompt} ${w}`;
    }
  }
}

const pane = herdrTry<{ pane?: { pane_id?: string } }>([
  'pane',
  'split',
  target,
  '--direction',
  'down',
  '--cwd',
  cwd,
  '--no-focus',
])?.pane?.pane_id;
if (pane === undefined) {
  console.error(`acp:watch — pane split failed under ${target}`);
  process.exit(1);
}

herdrTry(['pane', 'rename', pane, `${LABEL}${basename(cmd)}`]);
const args = [
  shq(process.execPath),
  shq(join(PLUGIN_ROOT, 'src', 'acp-watch.ts')),
  '--cmd',
  shq(cmd),
  '--cwd',
  shq(cwd),
  ...(prompt === undefined ? [] : ['--prompt', shq(prompt)]),
];
if (herdrTry(['pane', 'run', pane, args.join(' ')]) === undefined) {
  console.error(`acp:watch — pane run failed on ${pane}`);
  process.exit(1);
}
notify('acp watch', `${cmd} → ${pane}`);
console.log(`acp-watch → ${pane} (${cmd})`);
