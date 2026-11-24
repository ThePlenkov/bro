/**
 * The fleet webui — the document `GET /fleet` serves. Spec:
 * specs/sessions/bro-f4ot/bro-1rir.md + specs/bro-w4a45.md.
 *
 * One self-contained page: the CLI ships bundled `dist/` only, so the
 * document is a module string, not a static asset. The client script
 * polls the read planes — `/api/v1/{snapshot,agents,queue,ticks,
 * mailbox}` — via allSettled: a plane that 500s leaves its section on
 * the last good frame instead of blanking the board (chained
 * setTimeout — a slow collect stretches the cadence, never stacks;
 * paused while the tab is hidden). Renders via DOM `textContent` —
 * bead titles are user input, never `innerHTML`. Read-only: GETs
 * only; the respawn decision stays a surface, not a button.
 *
 * The agents table's `log` column opens a live tail per row
 * (spec bro-wwo7e): a `tail` link on registry rows expands a pane
 * streaming `GET /api/v1/agents/<ref>/log?follow` over EventSource.
 * That route is write-grade credentialed, so the page takes the
 * session token out-of-band — a `#token=` fragment (stripped via
 * replaceState) or a paste field — kept in sessionStorage per tab.
 *
 * The client script is assembled from the `webui-*.ts` segments in
 * script order — the module grew past the CodeScene file-size bar;
 * the served bytes are unchanged.
 *
 * Style note for editors: the page is a template literal — client JS
 * must not contain backticks or `${` sequences.
 */
import { createHash } from 'node:crypto';
import { WEBUI_AGENTS } from './webui-agents.ts';
import { WEBUI_DOM } from './webui-dom.ts';
import { WEBUI_GATES } from './webui-gates.ts';
import { WEBUI_LIVE } from './webui-live.ts';
import { WEBUI_LOG } from './webui-log.ts';
import { WEBUI_TICKS } from './webui-ticks.ts';

const PAGE_STYLE = `
  :root { color-scheme: dark; }
  body { background: #0d1117; color: #c9d1d9; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; padding: 1.5rem; }
  header { display: flex; align-items: baseline; gap: 1rem; border-bottom: 1px solid #30363d; padding-bottom: .5rem; margin-bottom: 1rem; }
  h1 { font-size: 1.1rem; margin: 0; color: #f0f6fc; }
  h2 { font-size: .95rem; color: #8b949e; text-transform: uppercase; letter-spacing: .05em; margin: 1.25rem 0 .4rem; }
  #ts { color: #8b949e; font-size: .8rem; }
  #err { color: #f85149; font-size: .8rem; }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .2rem .8rem .2rem 0; white-space: nowrap; }
  th { color: #8b949e; font-weight: normal; border-bottom: 1px solid #21262d; }
  td { border-bottom: 1px solid #161b22; }
  a { color: #58a6ff; text-decoration: none; }
  ul { margin: 0; padding-left: 1.2rem; }
  .quiet { color: #3fb950; }
  .warn { color: #d29922; }
  .bad { color: #f85149; }
  .muted { color: #8b949e; }
  .stale { opacity: .55; }
  .sum { margin: .2rem 0 .4rem; }
  #logpanel { margin: .3rem 0 .6rem; }
  #logpanel .sum a { margin-left: .6rem; }
  #logpane { background: #161b22; border: 1px solid #30363d; padding: .4rem .8rem; margin: .3rem 0 0; max-height: 22rem; overflow: auto; white-space: pre-wrap; word-break: break-word; font-size: .85rem; }
  #logauth input { background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; font: inherit; padding: .1rem .4rem; }
`;

// String.raw — the script ships regex literals; raw keeps `\[` written
// once instead of doubly escaped for the template
const PAGE_SCRIPT =
  String.raw`
var POLL_MS = 2000;
var PLANES = [
  '/api/v1/snapshot', '/api/v1/agents', '/api/v1/queue',
  '/api/v1/ticks', '/api/v1/mailbox',
];
function planeKey(p) { return p.slice('/api/v1/'.length); }
var root = document.body;
var timer;
var inFlight = false;
// last good frame per plane — a plane that fails this tick leaves its
// section on the previous frame instead of blanking
var last = {};

// --- live agent log (spec bro-wwo7e) -------------------------------------
var TOKEN_KEY = 'bro.serve.token';
var LOG_REPLAY = 200;   // lines= on open — the replay scrollback
var LOG_CAP = 300000;   // pane char budget — past it the head trims…
var LOG_KEEP = 150000;  // …down to this
var logChars = 0;
// the log stream is write-grade credentialed and a static page cannot
// hold the token — it arrives out-of-band: #token=<t> in the page URL
// (a same-UID handoff; replaceState strips it so it never persists in
// history) or a paste into the pane's token field. sessionStorage is
// per-tab — the credential dies with the tab.
var logToken = '';
try { logToken = sessionStorage.getItem(TOKEN_KEY) || ''; } catch (e) {}
var hashTok = /(?:^#|&)token=([^&]+)/.exec(location.hash || '');
if (hashTok) {
  try { logToken = decodeURIComponent(hashTok[1]); } catch (e) { logToken = ''; }
  if (logToken) {
    try { sessionStorage.setItem(TOKEN_KEY, logToken); } catch (e) {}
    history.replaceState(null, '', location.pathname + location.search);
  }
}
// one live tail at a time — the pane sits outside the polled tbody so
// the 2s re-render never wipes it
var logView = { ref: null, es: null };

` +
  WEBUI_DOM +
  WEBUI_LOG +
  WEBUI_AGENTS +
  WEBUI_GATES +
  WEBUI_TICKS +
  WEBUI_LIVE;

function cspHash(s: string): string {
  return createHash('sha256').update(s).digest('base64');
}

/** CSP for the HTML response — hash-pinned inline script/style (the
 *  hashes are computed from the exact bytes served, so an edit that
 *  forgets the pin fails closed), same-origin fetch, nothing else. A
 *  smuggled title can't execute or load anything even if markup
 *  injection ever slips through. */
export const WEBUI_CSP = `default-src 'none'; script-src 'sha256-${cspHash(PAGE_SCRIPT)}'; style-src 'sha256-${cspHash(PAGE_STYLE)}'; connect-src 'self'`;

export const FLEET_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>bro fleet</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<header>
  <h1>bro fleet</h1>
  <span id="ts">connecting…</span>
  <span id="err"></span>
</header>

<h2>attention</h2>
<ul id="attn"><li class="muted">…</li></ul>

<h2>agents</h2>
<div id="agentocc" class="sum muted"></div>
<div class="scroll"><table>
  <thead><tr><th>agent</th><th>backend</th><th>step</th><th>state</th><th>pid</th><th>provider</th><th>worktree</th><th>age</th><th>session</th><th>log</th></tr></thead>
  <tbody id="agents"><tr><td class="muted">…</td></tr></tbody>
</table></div>
<ul id="agentwarn"></ul>
<div id="logpanel" hidden>
  <div class="sum">log — <span id="logref"></span><a id="logtokbtn" href="#">token</a><a id="logclose" href="#">close</a></div>
  <div id="logauth" class="sum muted" hidden>session token — the token field in &lt;git-common&gt;/bro/serve.json
    <input id="logtoken" type="password" size="36" autocomplete="off" placeholder="paste token">
    <a id="logtoksave" href="#">set</a>
  </div>
  <pre id="logpane"></pre>
</div>

<h2>activity</h2>
<ul id="actfeed"><li class="muted">listening on the bus…</li></ul>

<h2>queue</h2>
<div id="queuesum" class="sum muted"></div>
<div class="scroll"><table>
  <thead><tr><th>bead</th><th>title</th><th>assignee</th></tr></thead>
  <tbody id="queue"><tr><td class="muted">…</td></tr></tbody>
</table></div>
<div id="queueready" class="sum muted"></div>

<h2>gates</h2>
<div class="scroll"><table>
  <thead><tr><th>pr</th><th>gate</th><th>mergeable</th><th>threads</th><th>ci</th><th>blockers</th></tr></thead>
  <tbody id="gates"><tr><td class="muted">…</td></tr></tbody>
</table></div>
<ul id="gatewarn"></ul>

<h2>ticks</h2>
<div id="ticksum" class="sum"></div>
<div class="scroll"><table>
  <thead><tr><th>pr</th><th>kind</th><th>pid</th><th>state</th><th>mode</th><th>armed</th><th>timeout</th></tr></thead>
  <tbody id="ticks"><tr><td class="muted">…</td></tr></tbody>
</table></div>

<h2>mailbox</h2>
<ul id="mail"><li class="muted">…</li></ul>

<h2>fleet</h2>
<div class="scroll"><table>
  <thead><tr><th>mol</th><th>step</th><th>state</th><th>agent</th><th>worktree</th><th>pr</th></tr></thead>
  <tbody id="fleet"><tr><td class="muted">…</td></tr></tbody>
</table></div>
<ul id="fleetwarn"></ul>

<h2>molecules</h2>
<ul id="mols"><li class="muted">…</li></ul>

<script>${PAGE_SCRIPT}</script>
</body>
</html>
`;
