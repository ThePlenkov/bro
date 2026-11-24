/** Script segment of the fleet webui's `FLEET_PAGE` — the live activity feed and the poll
 *  loop — `agentLine`, `liveActivity`, `renderAll`, `tick`, and the
 *  boot wiring.
 *  Split out of webui.ts (the module was past the CodeScene
 *  file-size bar); the segments concatenate in script order so
 *  the served bytes are unchanged. Same template-literal rules:
 *  no backticks, no `${` sequences in the client JS.
 */
export const WEBUI_LIVE = String.raw`// one line per 'agent' envelope — mirrors agentEventLine() server-side;
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
`;
