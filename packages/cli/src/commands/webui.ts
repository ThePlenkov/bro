/**
 * The fleet webui — the document `GET /fleet` serves. Spec:
 * specs/sessions/bro-f4ot/bro-1rir.md.
 *
 * One self-contained page: the CLI ships bundled `dist/` only, so the
 * document is a module string, not a static asset. The client script
 * polls `/api/v1/snapshot` (chained setTimeout — a slow collect
 * stretches the cadence, never stacks; paused while the tab is
 * hidden) and renders via DOM `textContent` — bead titles are user
 * input, never `innerHTML`. Read-only: GETs only; the respawn decision
 * stays a surface, not a button.
 *
 * Style note for editors: the page is a template literal — client JS
 * must not contain backticks or `${` sequences.
 */
import { createHash } from 'node:crypto'

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
`

const PAGE_SCRIPT = `
var POLL_MS = 2000;
var root = document.body;
var timer;
var inFlight = false;

function el(tag, text, cls) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function list(ul, items, cls) {
  ul.replaceChildren();
  if (items.length === 0) {
    ul.appendChild(el('li', '(quiet)', 'quiet'));
    return;
  }
  items.forEach(function (it) { ul.appendChild(el('li', it, cls)); });
}

// pr/g.link are markdown [#N](url) — the webui renders real anchors;
// https? only: a poisoned link can't navigate to a custom scheme.
// Anything after the link stays plain text
function appendPrLink(parent, md) {
  var m = /^\\[#(\\d+)\\]\\((https?:\\/\\/[^)]+)\\)(.*)$/.exec(md || '');
  if (m) {
    var a = el('a', '#' + m[1]);
    a.href = m[2];
    parent.appendChild(a);
    if (m[3]) parent.appendChild(document.createTextNode(m[3]));
  } else {
    parent.textContent = md || '—';
  }
}

function renderFleet(fleet) {
  var tbody = document.getElementById('fleet');
  tbody.replaceChildren();
  if (fleet.error) {
    var tr = el('tr');
    tr.appendChild(el('td', 'unavailable — ' + fleet.error, 'bad'));
    tbody.appendChild(tr);
  } else if (!fleet.rows || fleet.rows.length === 0) {
    var tr2 = el('tr');
    tr2.appendChild(el('td', 'no open molecules — nothing in the fleet', 'muted'));
    tbody.appendChild(tr2);
  } else {
    fleet.rows.forEach(function (r) {
      var tr = el('tr');
      tr.appendChild(el('td', r.mol));
      var step = el('td', r.step);
      if (r.title) step.title = r.title;
      tr.appendChild(step);
      tr.appendChild(el('td', r.state));
      tr.appendChild(el('td', r.agent || '—', r.agent === 'lost — respawn?' ? 'bad' : r.agent === 'unknown' ? 'warn' : undefined));
      tr.appendChild(el('td', r.worktree || '—', 'muted'));
      var pr = el('td');
      appendPrLink(pr, r.pr);
      if (!r.pr && r.prNum !== undefined) pr.textContent = '#' + r.prNum;
      tr.appendChild(pr);
      tbody.appendChild(tr);
    });
  }
  var warns = [].concat(fleet.degraded || [], fleet.conflicts || [], fleet.prErrors || []);
  list(document.getElementById('fleetwarn'), warns, 'warn');
}

function renderGates(gates) {
  var ul = document.getElementById('gates');
  ul.replaceChildren();
  if (!gates.available) {
    ul.appendChild(el('li', 'unavailable — ' + (gates.reason || 'no review host'), 'muted'));
    return;
  }
  if (gates.error) {
    ul.appendChild(el('li', 'unavailable — ' + gates.error, 'bad'));
    return;
  }
  var prs = gates.prs || [];
  var lookupErrors = gates.lookupErrors || [];
  if (prs.length === 0 && lookupErrors.length === 0) {
    ul.appendChild(el('li', '(quiet)', 'quiet'));
  }
  prs.forEach(function (g) {
    var suffix = g.error
      ? ' probe failed — ' + g.error
      : g.ok === false
        ? ' blocked — ' + (g.blockers || []).join('; ')
        : ' ok';
    var li = el('li');
    appendPrLink(li, g.link);
    li.appendChild(document.createTextNode(suffix));
    if (g.error || g.ok === false) li.className = 'bad';
    ul.appendChild(li);
  });
  lookupErrors.forEach(function (e) { ul.appendChild(el('li', e, 'warn')); });
}

function renderMols(mols, molsError) {
  var ul = document.getElementById('mols');
  if (molsError) {
    list(ul, ['unavailable — ' + molsError], 'bad');
    return;
  }
  var items = (mols || []).map(function (m) {
    var parts = [m.mol + ' — ' + m.state];
    if (m.ready && m.ready.length) parts.push('ready: ' + m.ready.map(function (s) { return s.id; }).join(', '));
    if (m.gates && m.gates.length) parts.push('gates: ' + m.gates.join(', '));
    if (m.inProgress && m.inProgress.length) parts.push('in-progress: ' + m.inProgress.join(', '));
    if (m.blocked && m.blocked.length) parts.push('blocked: ' + m.blocked.join(', '));
    return parts.join(' · ');
  });
  list(ul, items, undefined);
}

function render(snap) {
  document.getElementById('ts').textContent = 'updated ' + snap.ts + ' · every ' + (POLL_MS / 1000) + 's';
  document.getElementById('err').textContent = '';
  root.classList.remove('stale');
  list(document.getElementById('attn'), snap.attention || [], undefined);
  renderFleet(snap.fleet || { rows: [], degraded: [], conflicts: [] });
  renderGates(snap.gates || { available: false, prs: [] });
  renderMols(snap.mols, snap.molsError);
}

function tick() {
  // hidden tabs don't poll — visibilitychange re-arms; a fetch already
  // in flight owns the next schedule, so re-entry must not fork a
  // second loop
  if (document.hidden || inFlight) return;
  inFlight = true;
  fetch('/api/v1/snapshot')
    .then(function (res) {
      if (!res.ok) throw new Error('snapshot ' + res.status);
      return res.json();
    })
    .then(render)
    .catch(function (err) {
      // keep the last good frame — dim it and say why
      root.classList.add('stale');
      document.getElementById('err').textContent = 'poll failed — ' + err.message;
    })
    .finally(function () {
      inFlight = false;
      if (!document.hidden) timer = setTimeout(tick, POLL_MS);
    });
}

document.addEventListener('visibilitychange', function () {
  if (!document.hidden) {
    clearTimeout(timer);
    tick();
  }
});

tick();
`

function cspHash(s: string): string {
  return createHash('sha256').update(s).digest('base64')
}

/** CSP for the HTML response — hash-pinned inline script/style (the
 *  hashes are computed from the exact bytes served, so an edit that
 *  forgets the pin fails closed), same-origin fetch, nothing else. A
 *  smuggled title can't execute or load anything even if markup
 *  injection ever slips through. */
export const WEBUI_CSP = `default-src 'none'; script-src 'sha256-${cspHash(PAGE_SCRIPT)}'; style-src 'sha256-${cspHash(PAGE_STYLE)}'; connect-src 'self'`

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

<h2>fleet</h2>
<div class="scroll"><table>
  <thead><tr><th>mol</th><th>step</th><th>state</th><th>agent</th><th>worktree</th><th>pr</th></tr></thead>
  <tbody id="fleet"><tr><td class="muted">…</td></tr></tbody>
</table></div>
<ul id="fleetwarn"></ul>

<h2>gates</h2>
<ul id="gates"><li class="muted">…</li></ul>

<h2>molecules</h2>
<ul id="mols"><li class="muted">…</li></ul>

<script>${PAGE_SCRIPT}</script>
</body>
</html>
`
