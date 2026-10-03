/**
 * The fleet webui — the document `GET /fleet` serves. Spec:
 * specs/sessions/bro-f4ot/bro-1rir.md.
 *
 * One self-contained page: the CLI ships bundled `dist/` only, so the
 * document is a module string, not a static asset. The client script
 * polls `/api/v1/snapshot` (chained setTimeout — a slow collect
 * stretches the cadence, never stacks; skipped while the tab is
 * hidden) and renders via DOM `textContent` — bead titles are user
 * input, never `innerHTML`. Read-only: GETs only; the respawn decision
 * stays a surface, not a button.
 *
 * Style note for editors: the page is a template literal — client JS
 * must not contain backticks or `${` sequences.
 */

/** CSP for the HTML response — the page needs inline script/style and
 *  same-origin fetch, nothing else. A smuggled title can't load remote
 *  anything even if markup injection ever slips through. */
export const WEBUI_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'"

export const FLEET_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>bro fleet</title>
<style>
  :root { color-scheme: dark; }
  body { background: #0d1117; color: #c9d1d9; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; padding: 1.5rem; }
  header { display: flex; align-items: baseline; gap: 1rem; border-bottom: 1px solid #30363d; padding-bottom: .5rem; margin-bottom: 1rem; }
  h1 { font-size: 1.1rem; margin: 0; color: #f0f6fc; }
  h2 { font-size: .95rem; color: #8b949e; text-transform: uppercase; letter-spacing: .05em; margin: 1.25rem 0 .4rem; }
  #ts { color: #8b949e; font-size: .8rem; }
  #err { color: #f85149; font-size: .8rem; }
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
</style>
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
<table>
  <thead><tr><th>mol</th><th>step</th><th>state</th><th>agent</th><th>worktree</th><th>pr</th></tr></thead>
  <tbody id="fleet"><tr><td class="muted">…</td></tr></tbody>
</table>
<ul id="fleetwarn"></ul>

<h2>gates</h2>
<ul id="gates"><li class="muted">…</li></ul>

<h2>molecules</h2>
<ul id="mols"><li class="muted">…</li></ul>

<script>
var POLL_MS = 2000;
var root = document.body;

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

// r.pr / g.link are markdown [#N](url) — the webui renders real anchors
function prCell(td, md, num) {
  var m = /^\\[#(\\d+)\\]\\(([^)]+)\\)$/.exec(md || '');
  if (m) {
    var a = el('a', '#' + m[1]);
    a.href = m[2];
    td.appendChild(a);
  } else if (num !== undefined) {
    td.textContent = '#' + num;
  } else {
    td.textContent = md || '—';
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
      prCell(pr, r.pr, r.prNum);
      tr.appendChild(pr);
      tbody.appendChild(tr);
    });
  }
  var warns = [].concat(fleet.degraded || [], fleet.conflicts || [], fleet.prErrors || []);
  list(document.getElementById('fleetwarn'), warns, 'warn');
}

function renderGates(gates) {
  var ul = document.getElementById('gates');
  if (!gates.available) {
    list(ul, ['unavailable — ' + (gates.reason || 'no review host')], 'muted');
    return;
  }
  if (gates.error) {
    list(ul, ['unavailable — ' + gates.error], 'bad');
    return;
  }
  var items = (gates.prs || []).map(function (g) {
    if (g.error) return g.link + ' probe failed — ' + g.error;
    if (g.ok === false) return g.link + ' blocked — ' + (g.blockers || []).join('; ');
    return g.link + ' ok';
  });
  items = items.concat(gates.lookupErrors || []);
  list(ul, items, undefined);
  ul.querySelectorAll('li').forEach(function (li) {
    if (/blocked|failed/.test(li.textContent)) li.className = 'bad';
  });
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

var timer;
function tick() {
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
      timer = setTimeout(tick, POLL_MS);
    });
}

document.addEventListener('visibilitychange', function () {
  if (!document.hidden) {
    clearTimeout(timer);
    tick();
  }
});

tick();
</script>
</body>
</html>
`
