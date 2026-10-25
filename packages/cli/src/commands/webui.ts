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
  .sum { margin: .2rem 0 .4rem; }
  #logpanel { margin: .3rem 0 .6rem; }
  #logpanel .sum a { margin-left: .6rem; }
  #logpane { background: #161b22; border: 1px solid #30363d; padding: .4rem .8rem; margin: .3rem 0 0; max-height: 22rem; overflow: auto; white-space: pre-wrap; word-break: break-word; font-size: .85rem; }
  #logauth input { background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; font: inherit; padding: .1rem .4rem; }
`

// String.raw — the script ships regex literals; raw keeps `\[` written
// once instead of doubly escaped for the template
const PAGE_SCRIPT = String.raw`
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
  items.forEach(function (it) {
    var li = document.createElement('li');
    if (cls) li.className = cls;
    // a [#N](url) prefix becomes a real anchor — PR references are
    // always links, in warnings as much as in table cells
    if (/^\[#(\d+)\]\(https?:\/\/[^)]+\)/.test(it)) appendPrLink(li, it);
    else li.textContent = it;
    ul.appendChild(li);
  });
}

// pr/g.link are markdown [#N](url) — the webui renders real anchors;
// https? only: a poisoned link can't navigate to a custom scheme.
// Anything after the link stays plain text
function appendPrLink(parent, md) {
  var m = /^\[#(\d+)\]\((https?:\/\/[^)]+)\)(.*)$/.exec(md || '');
  if (m) {
    var a = el('a', '#' + m[1]);
    a.href = m[2];
    parent.appendChild(a);
    if (m[3]) parent.appendChild(document.createTextNode(m[3]));
  } else {
    parent.textContent = md || '—';
  }
}

function base(p) {
  if (!p) return '—';
  var i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

// '30s', '4m', '9h', '2d' — same smallest-honest-unit rule as the
// heartbeat file's own age formatter
function age(ms) {
  var s = Math.floor(ms / 1000);
  if (s < 90) return s + 's';
  var m = Math.floor(s / 60);
  if (m < 90) return m + 'm';
  var h = Math.floor(m / 60);
  if (h < 36) return h + 'h';
  return Math.floor(h / 24) + 'd';
}

// One appended line — pins to the bottom only while already near it,
// so reading backscroll isn't yanked away on each append; the pane
// trims its head past LOG_CAP so a long tail can't grow the DOM
// unboundedly.
function logLine(text, cls) {
  var pane = document.getElementById('logpane');
  var pinned = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 24;
  pane.appendChild(cls ? el('span', text + '\n', cls) : document.createTextNode(text + '\n'));
  logChars += text.length + 1;
  if (logChars > LOG_CAP) {
    while (logChars > LOG_KEEP && pane.firstChild) {
      logChars -= pane.firstChild.textContent.length;
      pane.removeChild(pane.firstChild);
    }
  }
  if (pinned) pane.scrollTop = pane.scrollHeight;
}

function closeLog() {
  if (logView.es !== null) logView.es.close();
  logView = { ref: null, es: null };
  document.getElementById('logpanel').hidden = true;
}

// tail on the open ref is the collapse gesture; a different ref swaps
// the stream. The endpoint emits data: log chunks, 'note' event state
// markers (truncated/removed/reopened), and never ends the stream
// itself — the client owns the lifetime.
function openLog(ref) {
  if (logView.ref === ref && logView.es !== null) { closeLog(); return; }
  if (logView.es !== null) logView.es.close();
  logView = { ref: ref, es: null };
  var panel = document.getElementById('logpanel');
  panel.hidden = false;
  panel.scrollIntoView({ block: 'nearest' });
  document.getElementById('logref').textContent = ref;
  var pane = document.getElementById('logpane');
  pane.textContent = '';
  logChars = 0;
  if (logToken === '') {
    // no credential yet — the token row is the next step
    document.getElementById('logauth').hidden = false;
    document.getElementById('logtoken').focus();
    return;
  }
  document.getElementById('logauth').hidden = true;
  if (typeof EventSource === 'undefined') {
    logLine('EventSource unsupported in this browser', 'bad');
    return;
  }
  logLine('[connecting]', 'muted');
  var es = new EventSource(
    '/api/v1/agents/' + encodeURIComponent(ref) +
    '/log?follow&lines=' + LOG_REPLAY + '&token=' + encodeURIComponent(logToken));
  logView.es = es;
  var got = false;
  es.onopen = function () {
    if (logView.es !== es) return;
    if (got) {
      // a reconnect replays the tail — wipe or it lands twice
      pane.textContent = '';
      logChars = 0;
      logLine('[reconnected — replaying]', 'muted');
    }
  };
  es.onmessage = function (e) {
    if (logView.es !== es) return;
    got = true;
    // one event = one chunk; a multi-data frame is a chunk fanned out
    // per line, and each frame ends a line (the endpoint's own read)
    logLine(e.data);
  };
  es.addEventListener('note', function (e) {
    if (logView.es !== es) return;
    logLine(e.data, 'muted');
  });
  // the endpoint never signals completion today; honor it if it does
  es.addEventListener('done', function () {
    if (logView.es !== es) return;
    logLine('[stream ended]', 'muted');
    es.close();
    logView.es = null;
  });
  es.onerror = function () {
    if (logView.es !== es) return;
    // CONNECTING is the browser retrying — leave it; a reconnect wipes
    // + replays via onopen. CLOSED is fatal — refused (bad token) or
    // gone (404/422).
    if (es.readyState === EventSource.CLOSED) {
      es.close();
      logView.es = null;
      logLine(got ? '[stream ended]' : '[refused — bad token, or the log is unavailable]', 'bad');
      if (!got) document.getElementById('logauth').hidden = false;
    }
  };
}

function saveLogToken(ev) {
  ev.preventDefault();
  var v = document.getElementById('logtoken').value.trim();
  if (v === '') return;
  logToken = v;
  try { sessionStorage.setItem(TOKEN_KEY, v); } catch (e) {}
  document.getElementById('logtoken').value = '';
  document.getElementById('logauth').hidden = true;
  if (logView.ref !== null) openLog(logView.ref);
}

// The agents union — registry agents first (the plane of record), then
// legacy loop runs, then session-plane discoveries the registry never
// saw. A discovered session whose BRO_AGENT_ID badge matches a
// registry agent folds into that row's session column — the same work
// counted twice would double-report occupancy.
function renderAgents(board, snap) {
  var tbody = document.getElementById('agents');
  var warns = [];
  var rows = [];
  var byId = {};
  board = board || {};
  (board.backends || []).forEach(function (b) {
    if (b.degraded) warns.push(b.name + ': ' + b.degraded);
    (b.agents || []).forEach(function (a) {
      var r = {
        id: a.id, backend: b.name, step: a.molStep || '—',
        ref: a.id,
        state: a.state + (a.cause ? ' · ' + a.cause : ''),
        bad: a.state === 'lost' || a.state === 'blocked',
        pid: a.pid,
        prov: [a.provider, a.model].filter(Boolean).join('/') || '—',
        worktree: a.worktree, log: a.log,
        ageMs: a.spawnedAt ? Math.max(0, Date.now() - Date.parse(a.spawnedAt)) : undefined,
        session: ''
      };
      byId[a.id] = r;
      rows.push(r);
    });
  });
  var loopRuns = (((snap || {}).loop || {}).runs) || [];
  var normTree = function (t) { return typeof t === 'string' ? t.replace(/\/+$/, '') : t };
  loopRuns.forEach(function (r) {
    // a registry-backed loop worker rides the record now (bro-wg896) —
    // the same work in both planes folds into the registry row, its
    // silence read merging in; a DEAD record never folds — crashed-run
    // residue is its own row
    if (r.state !== 'dead') {
      var hit = rows.find(function (x) {
        return (r.pid !== null && r.pid !== undefined && x.pid === r.pid) ||
          (normTree(x.worktree) !== undefined && normTree(x.worktree) === normTree(r.worktree));
      });
      if (hit !== undefined) {
        if (r.silentMs !== null && r.silentMs !== undefined) {
          hit.ageMs = r.silentMs;
          hit.ageNote = 'silent ';
        }
        return;
      }
    }
    rows.push({
      id: 'loop:' + (r.slug || r.beadId || ''), backend: 'loop',
      step: r.beadId || r.slug || '—',
      state: r.state === 'dead' ? 'dead' : 'running',
      bad: r.state === 'dead',
      pid: r.pid === null ? undefined : r.pid,
      prov: '—', worktree: r.worktree, log: r.log,
      ageMs: r.silentMs === null || r.silentMs === undefined ? undefined : r.silentMs,
      ageNote: r.silentMs === null || r.silentMs === undefined ? '' : 'silent ',
      session: ''
    });
  });
  (board.discovered || []).forEach(function (s) {
    var label = s.kind + ':' + (s.name || 'pid ' + s.pid);
    // fold onto the registry row by badge, or onto the connector's own
    // projection of the same session (a devin-backend row ids itself
    // devin:<name> — listing it again as a discovered row would
    // double-count one live session)
    var hit = s.agentId !== undefined && s.agentId !== '' ? byId[s.agentId] : undefined;
    if (hit === undefined) {
      hit = byId[s.kind + ':' + (s.name || s.pid)];
    }
    if (hit !== undefined) {
      // the session is this agent's inner process — annotate, don't
      // double-count
      hit.session = label;
      return;
    }
    rows.push({
      id: s.name || 'pid ' + s.pid, backend: s.kind,
      step: s.agentId || '—',
      state: s.worker === false ? 'interactive' : 'worker',
      bad: false,
      pid: s.pid, prov: '—', worktree: undefined, log: undefined,
      session: ''
    });
  });
  tbody.replaceChildren();
  if (rows.length === 0) {
    tbody.appendChild(el('tr')).appendChild(el('td', 'no agents — registry, loop, and session planes all quiet', 'muted'));
  }
  rows.forEach(function (r) {
    var tr = el('tr');
    tr.appendChild(el('td', r.id));
    tr.appendChild(el('td', r.backend, 'muted'));
    tr.appendChild(el('td', r.step));
    tr.appendChild(el('td', r.state, r.bad ? 'bad' : undefined));
    tr.appendChild(el('td', r.pid === undefined ? '—' : String(r.pid)));
    tr.appendChild(el('td', r.prov, 'muted'));
    var wt = el('td', base(r.worktree), 'muted');
    var tip = [];
    if (r.worktree) tip.push(r.worktree);
    if (r.log) tip.push(r.log);
    if (tip.length > 0) wt.title = tip.join(' · ');
    tr.appendChild(wt);
    tr.appendChild(el('td', r.ageMs === undefined ? '—' : (r.ageNote || '') + age(r.ageMs), 'muted'));
    tr.appendChild(el('td', r.session || '—', 'muted'));
    // tail — only rows the log route can resolve (registry agentIds)
    // with a local log path; remote pointers name their surface, and
    // loop/discovered rows aren't endpoint refs (404/422 on open)
    var lt = el('td');
    if (r.ref !== undefined && typeof r.log === 'string' && r.log !== '') {
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(r.log)) {
        lt.appendChild(el('span', 'remote', 'muted'));
        lt.title = r.log;
      } else {
        var tail = el('a', 'tail', logView.ref === r.ref && logView.es !== null ? 'quiet' : undefined);
        tail.href = '#';
        (function (ref) {
          tail.onclick = function (ev) { ev.preventDefault(); openLog(ref); };
        })(r.ref);
        lt.appendChild(tail);
      }
    } else {
      lt.appendChild(el('span', '—', 'muted'));
    }
    tr.appendChild(lt);
    tbody.appendChild(tr);
  });
  // occupancy + armed quota lanes — the fleet-cap accounting plus
  // host-wide session pressure, same lines bro agents status prints
  var occ = board.occupancy || { occupied: 0, maxConcurrent: 0 };
  var sum = 'fleet: ' + occ.occupied + (occ.maxConcurrent > 0 ? '/' + occ.maxConcurrent : '') + ' agent slots occupied' + (occ.maxConcurrent > 0 ? '' : ' (uncapped)');
  (board.sessions || []).forEach(function (s) {
    var label = s.lane === 'workers' ? 'workers' : 'sessions';
    if (s.invalid) {
      sum += ' · ' + s.kind + ' ' + label + ': invalid agents.' + s.kind + '.' + (s.invalidKey || 'maxSessions');
    } else {
      sum += ' · ' + s.kind + ' ' + label + ': ' + (s.live >= 0 ? s.live + '/' + s.max : '?/' + s.max) + ' live';
    }
  });
  document.getElementById('agentocc').textContent = sum;
  list(document.getElementById('agentwarn'), warns.concat(board.degraded || []), 'warn');
}

function renderQueue(q) {
  var sum = document.getElementById('queuesum');
  var tbody = document.getElementById('queue');
  var readyLine = document.getElementById('queueready');
  q = q || {};
  var claimed = q.inProgress || [];
  var ready = q.ready || [];
  var readyTotal = q.readyTotal === undefined ? ready.length : q.readyTotal;
  sum.textContent = 'claimed ' + claimed.length + ' · ready ' + readyTotal;
  sum.className = 'sum muted';
  tbody.replaceChildren();
  if (claimed.length === 0) {
    tbody.appendChild(el('tr')).appendChild(el('td', 'nothing claimed — no in-progress beads', 'muted'));
  }
  claimed.forEach(function (b) {
    var tr = el('tr');
    tr.appendChild(el('td', b.id));
    var t = el('td', b.title || '—');
    if (b.title) t.title = b.title;
    tr.appendChild(t);
    tr.appendChild(el('td', b.assignee || '—', 'muted'));
    tbody.appendChild(tr);
  });
  readyLine.textContent = ready.length === 0
    ? (readyTotal > 0 ? 'ready: ' + readyTotal + ' bead(s) beyond the board cap' : '')
    : 'ready: ' + ready.map(function (b) { return b.id; }).join(', ') + (readyTotal > ready.length ? ' …+' + (readyTotal - ready.length) : '');
}

function renderGates(gates) {
  var tbody = document.getElementById('gates');
  var warns = [];
  tbody.replaceChildren();
  gates = gates || {};
  if (!gates.available) {
    tbody.appendChild(el('tr')).appendChild(el('td', 'unavailable — ' + (gates.reason || 'no review host'), 'muted'));
  } else if (gates.error) {
    tbody.appendChild(el('tr')).appendChild(el('td', 'unavailable — ' + gates.error, 'bad'));
  } else {
    var prs = gates.prs || [];
    if (prs.length === 0) {
      tbody.appendChild(el('tr')).appendChild(el('td', 'no open PRs in the fleet', 'muted'));
    }
    prs.forEach(function (g) {
      var tr = el('tr');
      var pr = el('td');
      appendPrLink(pr, g.link);
      tr.appendChild(pr);
      var verdict, cls;
      if (g.error) { verdict = 'probe failed'; cls = 'bad'; warns.push((g.link || '#' + g.pr) + ': ' + g.error); }
      else if (g.ok === false) { verdict = 'blocked'; cls = 'bad'; }
      else if (g.ok === true) { verdict = 'ok'; cls = 'quiet'; }
      else { verdict = '—'; }
      tr.appendChild(el('td', verdict, cls));
      var mergeable = g.mergeable === undefined
        ? '—'
        : g.mergeable.toLowerCase() + (g.mergeState && g.mergeState !== 'CLEAN' ? ' · ' + g.mergeState.toLowerCase() : '');
      tr.appendChild(el('td', mergeable, g.mergeable === 'CONFLICTING' ? 'bad' : (g.mergeState === 'BEHIND' ? 'warn' : undefined)));
      tr.appendChild(el('td', g.openThreads === undefined ? '—' : String(g.openThreads), g.openThreads > 0 ? 'bad' : undefined));
      var ci;
      if (g.ciPending === undefined && g.ciFailing === undefined) {
        ci = '—';
      } else {
        var parts = [];
        if (g.ciFailing > 0) parts.push(g.ciFailing + ' failing');
        if (g.ciPending > 0) parts.push(g.ciPending + ' pending');
        if (g.reviewersPending > 0) parts.push(g.reviewersPending + ' reviewing');
        if (g.sastPending > 0) parts.push(g.sastPending + ' sast');
        ci = parts.length === 0 ? 'ok' : parts.join(' · ');
      }
      tr.appendChild(el('td', ci, g.ciFailing > 0 ? 'bad' : ((g.ciPending > 0 || g.reviewersPending > 0) ? 'warn' : undefined)));
      tr.appendChild(el('td', (g.blockers || []).join('; ') || '—', (g.blockers || []).length > 0 ? 'warn' : 'muted'));
      (g.alerts || []).forEach(function (a) { warns.push((g.link || '#' + g.pr) + ': ' + a); });
      tbody.appendChild(tr);
    });
    (gates.lookupErrors || []).forEach(function (e) { warns.push(e); });
  }
  list(document.getElementById('gatewarn'), warns, 'warn');
}

function renderTicks(t) {
  var sum = document.getElementById('ticksum');
  var tbody = document.getElementById('ticks');
  t = t || {};
  var parts = [];
  var cls = 'sum';
  if (t.heartbeat === null || t.heartbeat === undefined) {
    parts.push('no heartbeat — no watch has ticked here');
    cls += ' muted';
  } else {
    parts.push('last tick ' + age(t.heartbeat.ageMs) + ' ago — ' + (t.heartbeat.attention === 0 ? 'quiet' : t.heartbeat.attention + ' attention'));
    if (t.heartbeat.ageMs > 30 * 60 * 1000) cls += ' warn';
  }
  var d = t.drive || { pid: null, alive: false };
  if (d.pid === null || d.pid === undefined) {
    parts.push('drive: no supervisor');
  } else if (d.alive) {
    parts.push('drive: alive · pid ' + d.pid + (d.ageMs === undefined ? '' : ' · lock ' + age(d.ageMs)));
  } else {
    parts.push('drive: dead — stale lock pid ' + d.pid + (d.ageMs === undefined ? '' : ' · ' + age(d.ageMs) + ' old'));
    cls += ' warn';
  }
  sum.textContent = parts.join(' · ');
  sum.className = cls;
  tbody.replaceChildren();
  var watches = t.watches || [];
  if (watches.length === 0) {
    tbody.appendChild(el('tr')).appendChild(el('td', 'no armed watches', 'muted'));
  }
  watches.forEach(function (w) {
    var tr = el('tr');
    var pr = el('td');
    appendPrLink(pr, w.link);
    tr.appendChild(pr);
    tr.appendChild(el('td', w.kind || '—', 'muted'));
    tr.appendChild(el('td', String(w.pid)));
    var state, scls;
    if (w.verdict) { state = w.verdict + (w.blockers && w.blockers.length ? ' — ' + w.blockers.join('; ') : ''); scls = 'warn'; }
    else if (w.alive) { state = 'armed'; }
    else { state = 'stale' + (w.reported ? ' (reported)' : ''); scls = 'bad'; }
    tr.appendChild(el('td', state, scls));
    tr.appendChild(el('td', (w.merge ? 'merge' : 'watch') + (w.cleanup ? '+cleanup' : ''), 'muted'));
    tr.appendChild(el('td', w.ageMs === undefined ? '—' : age(w.ageMs), 'muted'));
    tr.appendChild(el('td', w.timeoutMin === undefined ? '—' : w.timeoutMin + 'm', 'muted'));
    tbody.appendChild(tr);
  });
}

function renderMailbox(mb) {
  var ul = document.getElementById('mail');
  var drops = ((mb || {}).drops) || [];
  list(ul, drops.map(function (d) {
    return age(Math.max(0, Date.now() - d.ts)) + ' — ' + d.text;
  }), undefined);
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
      tr.appendChild(el('td', r.agent || '—', r.agent === 'lost — respawn?' ? 'bad' : (r.agent === 'unknown' || (r.agent || '').startsWith('blocked — ')) ? 'warn' : undefined));
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

// one line per 'agent' envelope — mirrors agentEventLine() server-side;
// the wire carries raw envelopes, the pane renders the same shapes
function agentLine(e) {
  var p = e.payload || {};
  var who = e.key || 'agent';
  if (e.kind === 'turn') {
    if (p.phase === 'start') return who + ': turn started';
    return who + ': turn ' + (p.error ? 'failed — ' + p.error : 'stopped' + (p.stopReason ? ' (' + p.stopReason + ')' : ''));
  }
  if (e.kind === 'tool_call') {
    return who + ': ' + (p.title || p.name || p.toolCallId || 'tool') +
      (p.phase === 'open' ? ' started' : ' finished' + (p.status ? ' (' + p.status + ')' : '')) +
      (p.kind ? ' [' + p.kind + ']' : '');
  }
  if (e.kind === 'subagent') {
    return who + ': subagent ' + (p.title || p.sessionId || '?') + (p.phase ? ' ' + p.phase : '');
  }
  if (e.kind === 'usage') {
    return who + ': context ' + (p.used === undefined ? '?' : p.used) + '/' + (p.size === undefined ? '?' : p.size);
  }
  return who + ': ' + e.kind;
}

// the live activity pane — a bus subscriber over /api/v1/events/stream,
// NOT a file tail (bro-0ppt0): the broker ring is the live tail; the
// .events.jsonl archive is the durable record. EventSource auto-resumes
// via Last-Event-ID; 'gap' frames mean re-derive — the feed just keeps
// newest-first lines and the next event reconciles the view.
function liveActivity() {
  var feed = document.getElementById('actfeed');
  if (feed === null || typeof EventSource === 'undefined') return;
  var lines = [];
  var src = new EventSource('/api/v1/events/stream');
  src.onmessage = function (ev) {
    var e;
    try { e = JSON.parse(ev.data); } catch (x) { return; }
    if (!e || e.topic !== 'agent') return;
    lines.push(agentLine(e));
    if (lines.length > 60) lines = lines.slice(-60);
    list(feed, lines.slice().reverse(), undefined);
  };
  src.onopen = function () { feed.classList.remove('stale'); };
  src.onerror = function () {
    // auto-reconnect is EventSource's job — flag the pane stale so a
    // dead broker reads as quiet-but-stale, not live
    feed.classList.add('stale');
  };
}

function renderAll(failed) {
  var snap = last.snapshot;
  document.getElementById('ts').textContent =
    'updated ' + new Date().toISOString() + (snap && snap.ts ? ' · snapshot ' + snap.ts : '') + ' · every ' + (POLL_MS / 1000) + 's';
  document.getElementById('err').textContent = failed.length === 0 ? '' : 'stale — ' + failed.join(' · ');
  root.classList.toggle('stale', failed.length > 0);
  snap = snap || {};
  list(document.getElementById('attn'), snap.attention || [], undefined);
  renderAgents(last.agents, snap);
  renderQueue(last.queue);
  renderGates(snap.gates);
  renderTicks(last.ticks);
  renderMailbox(last.mailbox);
  renderFleet(snap.fleet || { rows: [], degraded: [], conflicts: [] });
  renderMols(snap.mols, snap.molsError);
}

function tick() {
  // hidden tabs don't poll — visibilitychange re-arms; a fetch already
  // in flight owns the next schedule, so re-entry must not fork a
  // second loop
  if (document.hidden || inFlight) return;
  inFlight = true;
  Promise.allSettled(PLANES.map(function (p) {
    return fetch(p).then(function (res) {
      if (!res.ok) throw new Error(planeKey(p) + ' ' + res.status);
      return res.json();
    }).then(function (body) { last[planeKey(p)] = body; });
  })).then(function (results) {
    var failed = [];
    results.forEach(function (r, i) {
      if (r.status === 'rejected') failed.push(r.reason && r.reason.message ? r.reason.message : planeKey(PLANES[i]));
    });
    renderAll(failed);
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

liveActivity();
document.getElementById('logclose').onclick = function (ev) {
  ev.preventDefault();
  closeLog();
};
document.getElementById('logtokbtn').onclick = function (ev) {
  ev.preventDefault();
  var a = document.getElementById('logauth');
  a.hidden = !a.hidden;
};
document.getElementById('logtoksave').onclick = saveLogToken;
document.getElementById('logtoken').addEventListener('keydown', function (ev) {
  if (ev.key === 'Enter') saveLogToken(ev);
});
window.addEventListener('pagehide', closeLog);

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
`
