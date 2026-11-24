/** Script segment of the fleet webui's `FLEET_PAGE` — the ticks/mailbox/fleet/mols sections —
 *  `heartbeatPart`, `drivePart`, `watchState`, `watchRow`,
 *  `renderTicks`, `renderMailbox`, `renderFleet`, `renderMols`.
 *  Split out of webui.ts (the module was past the CodeScene
 *  file-size bar); the segments concatenate in script order so
 *  the served bytes are unchanged. Same template-literal rules:
 *  no backticks, no `${` sequences in the client JS.
 */
export const WEBUI_TICKS = String.raw`// the tick summary's two probe segments — each returns one { text,
// muted, warn } so renderTicks stays a flat join; muted is the
// no-heartbeat tone, warn raises the line's class
function heartbeatPart(hb) {
  if (hb === null || hb === undefined) {
    return { text: 'no heartbeat — no watch has ticked here', muted: true };
  }
  var htail = hb.attention === 0 ? 'quiet' : hb.attention + ' attention';
  if (hb.futureMs !== undefined) {
    return { text: 'last tick stamped ' + age(hb.futureMs) + ' in the future — writer or reader clock skew — ' + htail, warn: true };
  }
  if (hb.writerSkewed) {
    return { text: 'last tick ' + age(hb.ageMs) + ' ago — writer clock skew — ' + htail, warn: true };
  }
  return { text: 'last tick ' + age(hb.ageMs) + ' ago — ' + htail, warn: hb.ageMs > 30 * 60 * 1000 };
}

function drivePart(d) {
  if (d.pid === null || d.pid === undefined) {
    return { text: 'drive: no supervisor' };
  }
  if (d.alive) {
    return { text: 'drive: alive · pid ' + d.pid + (d.ageMs === undefined ? '' : ' · lock ' + age(d.ageMs)) };
  }
  return { text: 'drive: dead — stale lock pid ' + d.pid + (d.ageMs === undefined ? '' : ' · ' + age(d.ageMs) + ' old'), warn: true };
}

function watchState(w) {
  if (w.verdict) {
    return { state: w.verdict + (w.blockers && w.blockers.length ? ' — ' + w.blockers.join('; ') : ''), cls: 'warn' };
  }
  if (w.alive) {
    return { state: 'armed' };
  }
  return { state: 'stale' + (w.reported ? ' (reported)' : ''), cls: 'bad' };
}

// one armed-watch row — the verdict state colors the row, the rest is
// muted facts
function watchRow(w) {
  var tr = el('tr');
  var pr = el('td');
  appendPrLink(pr, w.link);
  tr.appendChild(pr);
  tr.appendChild(el('td', w.kind || '—', 'muted'));
  tr.appendChild(el('td', String(w.pid)));
  var s = watchState(w);
  tr.appendChild(el('td', s.state, s.cls));
  tr.appendChild(el('td', (w.merge ? 'merge' : 'watch') + (w.cleanup ? '+cleanup' : ''), 'muted'));
  tr.appendChild(el('td', w.ageMs === undefined ? '—' : age(w.ageMs), 'muted'));
  tr.appendChild(el('td', w.timeoutMin === undefined ? '—' : w.timeoutMin + 'm', 'muted'));
  return tr;
}

function renderTicks(t) {
  var sum = document.getElementById('ticksum');
  var tbody = document.getElementById('ticks');
  t = t || {};
  var parts = [];
  var cls = 'sum';
  var hp = heartbeatPart(t.heartbeat);
  parts.push(hp.text);
  if (hp.muted) cls += ' muted';
  if (hp.warn) cls += ' warn';
  var dp = drivePart(t.drive || { pid: null, alive: false });
  parts.push(dp.text);
  if (dp.warn) cls += ' warn';
  sum.textContent = parts.join(' · ');
  sum.className = cls;
  tbody.replaceChildren();
  var watches = t.watches || [];
  if (watches.length === 0) {
    tbody.appendChild(el('tr')).appendChild(el('td', 'no armed watches', 'muted'));
  }
  watches.forEach(function (w) {
    tbody.appendChild(watchRow(w));
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

`;
