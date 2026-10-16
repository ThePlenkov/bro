/**
 * The plane-catalog dashboard — the document `GET /ui` serves. Spec:
 * specs/bro-9rls.1.md "The thin client — /ui" (bro-9rls.4).
 *
 * One self-contained page on the serve host, same shape as FLEET_PAGE:
 * bundled module string, inline CSS/JS, hash-pinned CSP, `textContent`
 * only, loopback Host guard upstream. The layout is GENERATED from
 * `GET /api/v1/planes` — the index is the contract: one panel per
 * descriptor, capability-false planes dimmed, error-ed planes rendered
 * `unavailable`. `/fleet` keeps the bespoke hand-laid view; this is
 * the transport-agnostic mirror of the MCP tool surface.
 *
 * Transport: chained-setTimeout poll of each capable plane's list (the
 * same discipline as /fleet — hidden tabs don't poll, last-good frames
 * survive a failed tick). When the events plane advertises `stream`
 * the page also opens `/api/v1/events/stream` (bro-9rls.5) — any event
 * re-arms an early tick; a dead stream just drops back to the poll,
 * the ladder is client-side.
 *
 * Read-only v1 — verb surfaces render as muted badges, never buttons:
 * writes need the serve.json Bearer token, which a page cannot hold.
 *
 * Style note for editors: the page is a template literal — client JS
 * must not contain backticks or `${` sequences.
 */
import { createHash } from 'node:crypto'

const UI_STYLE = `
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
  .muted { color: #8b949e; }
  .quiet { color: #3fb950; }
  .warn { color: #d29922; }
  .bad { color: #f85149; }
  .dim { opacity: .5; }
  .badge { font-size: .75rem; border: 1px solid #30363d; border-radius: .5rem; padding: 0 .4rem; margin-right: .3rem; color: #8b949e; }
  .badge.ok { color: #3fb950; border-color: #238636; }
  .badge.no { color: #f85149; border-color: #da3633; }
  .meta { font-size: .8rem; margin: .1rem 0 .3rem; }
`

// String.raw — the script ships regex literals; raw keeps them written once
const UI_SCRIPT = String.raw`
var POLL_MS = 2000;
var INDEX = '/api/v1/planes';
var STREAM = '/api/v1/events/stream';
var timer;
var inFlight = false;
// last good frame — index plus a list body per plane name
var last = { index: null, lists: {} };
var evtSource = null;

function el(tag, text, cls) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function cell(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') {
    var s = JSON.stringify(v);
    return s.length > 80 ? s.slice(0, 79) + '…' : s;
  }
  return String(v);
}

// one panel per catalog entry — the index IS the layout
function renderPanels(index, failed) {
  var host = document.getElementById('panels');
  host.replaceChildren();
  var planes = (index && index.planes) || [];
  planes.forEach(function (p) {
    var caps = (p && p.capabilities) || {};
    var readable = caps.read === true;
    var section = el('section', undefined, readable ? undefined : 'dim');
    var h = el('h2', p.name);
    (p.reads || []).forEach(function (r) {
      var a = el('a', r, 'badge');
      a.href = INDEX + '/' + encodeURIComponent(p.name) + '/' + encodeURIComponent(r);
      a.title = 'named read';
      h.appendChild(document.createTextNode(' '));
      h.appendChild(a);
    });
    (p.verbs || []).forEach(function (v) {
      var b = el('span', v, 'badge');
      b.title = 'declared verb — writes need the session token';
      h.appendChild(document.createTextNode(' '));
      h.appendChild(b);
    });
    Object.keys(caps).forEach(function (c) {
      var b = el('span', c, 'badge ' + (caps[c] === true ? 'ok' : 'no'));
      b.title = 'live capability';
      h.appendChild(document.createTextNode(' '));
      h.appendChild(b);
    });
    section.appendChild(h);
    var tbody = el('tbody');
    var wrap = el('div', undefined, 'scroll');
    var table = el('table');
    if (!readable) {
      tbody.appendChild(el('tr')).appendChild(
        el('td', caps.error === true ? 'unavailable — capability probe errored' : 'unavailable — cannot read', 'muted'));
    } else if (failed.indexOf(p.name) >= 0) {
      tbody.appendChild(el('tr')).appendChild(el('td', 'unavailable — ' + p.name + ' fetch failed', 'bad'));
    } else {
      var rows = last.lists[p.name] || [];
      if (rows.length === 0) {
        tbody.appendChild(el('tr')).appendChild(el('td', '(empty)', 'muted'));
      } else {
        var keys = ['id'];
        rows.forEach(function (r) {
          Object.keys(r || {}).forEach(function (k) {
            if (k !== 'id' && keys.indexOf(k) < 0) keys.push(k);
          });
        });
        var thead = el('thead');
        var hr = el('tr');
        keys.forEach(function (k) { hr.appendChild(el('th', k)); });
        thead.appendChild(hr);
        table.appendChild(thead);
        rows.forEach(function (r) {
          var tr = el('tr');
          keys.forEach(function (k) {
            var td = el('td');
            if (k === 'id') {
              var a = el('a', cell(r.id));
              a.href = INDEX + '/' + encodeURIComponent(p.name) + '/' + encodeURIComponent(String(r.id));
              td.appendChild(a);
            } else {
              td.textContent = cell(r[k]);
            }
            tr.appendChild(td);
          });
          tbody.appendChild(tr);
        });
      }
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    section.appendChild(wrap);
    host.appendChild(section);
  });
}

// an event from the stream re-arms an early poll — the stream carries
// no payloads the page trusts, it only says "state moved"
function armStream(index) {
  var planes = (index && index.planes) || [];
  var events = planes.find(function (p) { return p && p.name === 'events'; });
  var canStream = events && events.capabilities && events.capabilities.stream === true;
  if (canStream && evtSource === null && typeof EventSource !== 'undefined') {
    evtSource = new EventSource(STREAM);
    evtSource.onmessage = function () {
      if (!document.hidden) {
        clearTimeout(timer);
        tick();
      }
    };
    evtSource.onerror = function () {
      // stream death is a client-side step of the ladder — the poll
      // cadence already covers the gap; retry comes with the next
      // index fetch that still advertises stream
      if (evtSource) { evtSource.close(); evtSource = null; }
    };
  } else if (!canStream && evtSource !== null) {
    evtSource.close();
    evtSource = null;
  }
}

function tick() {
  if (document.hidden || inFlight) return;
  inFlight = true;
  fetch(INDEX).then(function (res) {
    if (!res.ok) throw new Error('planes ' + res.status);
    return res.json();
  }).then(function (index) {
    last.index = index;
    armStream(index);
    var capable = ((index && index.planes) || []).filter(function (p) {
      return p && p.capabilities && p.capabilities.read === true;
    });
    return Promise.allSettled(capable.map(function (p) {
      return fetch(INDEX + '/' + encodeURIComponent(p.name) + '?limit=64').then(function (res) {
        if (!res.ok) throw new Error(p.name);
        return res.json();
      }).then(function (rows) { last.lists[p.name] = rows; });
    }));
  }).then(function (results) {
    var failed = [];
    (results || []).forEach(function (r) {
      if (r.status === 'rejected') failed.push(r.reason && r.reason.message ? r.reason.message : 'plane');
    });
    renderPanels(last.index, failed);
    document.getElementById('ts').textContent =
      'updated ' + new Date().toISOString() + ' · every ' + (POLL_MS / 1000) + 's' + (evtSource ? ' · live' : '');
    document.getElementById('err').textContent = failed.length === 0 ? '' : 'stale — ' + failed.join(' · ');
  }).catch(function (e) {
    // the index itself is down — keep last good panels, flag stale
    renderPanels(last.index, []);
    document.getElementById('err').textContent = 'stale — ' + (e && e.message ? e.message : 'planes');
  }).finally(function () {
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

/** CSP for the /ui response — hash-pinned inline script/style,
 *  same-origin fetch only (EventSource rides connect-src 'self'). */
export const UI_CSP = `default-src 'none'; script-src 'sha256-${cspHash(UI_SCRIPT)}'; style-src 'sha256-${cspHash(UI_STYLE)}'; connect-src 'self'`

export const UI_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>bro planes</title>
<style>${UI_STYLE}</style>
</head>
<body>
<header>
  <h1>bro planes</h1>
  <span id="ts">connecting…</span>
  <span id="err"></span>
</header>

<div id="panels"><div class="muted">loading catalog…</div></div>

<script>${UI_SCRIPT}</script>
</body>
</html>
`
