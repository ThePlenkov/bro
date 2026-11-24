/** Script segment of the fleet webui's `FLEET_PAGE` — the agents union ingest (`normTree`,
 *  `ingestBackendAgents`, `ingestLoopRuns`, `renderAgents`) and the
 *  queue section (`renderQueue`).
 *  Split out of webui.ts (the module was past the CodeScene
 *  file-size bar); the segments concatenate in script order so
 *  the served bytes are unchanged. Same template-literal rules:
 *  no backticks, no `${` sequences in the client JS.
 */
export const WEBUI_AGENTS = String.raw`function normTree(t) {
  return typeof t === 'string' ? t.replace(/\/+$/, '') : t;
}

function ingestBackendAgents(board, rows, byId, warns) {
  (board.backends || []).forEach(function (b) {
    if (b.degraded) warns.push(b.name + ': ' + b.degraded);
    (b.agents || []).forEach(function (a) {
      var r = {
        id: a.id,
        backend: b.name,
        step: a.molStep || '—',
        ref: a.id,
        state: a.state + (a.cause ? ' · ' + a.cause : ''),
        bad: a.state === 'lost' || a.state === 'blocked',
        pid: a.pid,
        prov: [a.provider, a.model].filter(Boolean).join('/') || '—',
        worktree: a.worktree,
        log: a.log,
        ageMs: a.spawnedAt ? Math.max(0, Date.now() - Date.parse(a.spawnedAt)) : undefined,
        session: ''
      };
      byId[a.id] = r;
      rows.push(r);
    });
  });
}

function ingestLoopRuns(snap, rows) {
  var loopRuns = (((snap || {}).loop || {}).runs) || [];
  loopRuns.forEach(function (r) {
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
      id: 'loop:' + (r.slug || r.beadId || ''),
      backend: 'loop',
      step: r.beadId || r.slug || '—',
      state: r.state === 'dead' ? 'dead' : 'running',
      bad: r.state === 'dead',
      pid: r.pid === null ? undefined : r.pid,
      prov: '—',
      worktree: r.worktree,
      log: r.log,
      ageMs: r.silentMs === null || r.silentMs === undefined ? undefined : r.silentMs,
      ageNote: r.silentMs === null || r.silentMs === undefined ? '' : 'silent ',
      session: ''
    });
  });
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
  ingestBackendAgents(board, rows, byId, warns);
  ingestLoopRuns(snap, rows);
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

`;
