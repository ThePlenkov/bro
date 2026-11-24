/** Script segment of the fleet webui's `FLEET_PAGE` — the gates section — `gateVerdict`,
 *  `gateCi`, `renderGatePr`, `renderGates`.
 *  Split out of webui.ts (the module was past the CodeScene
 *  file-size bar); the segments concatenate in script order so
 *  the served bytes are unchanged. Same template-literal rules:
 *  no backticks, no `${` sequences in the client JS.
 */
export const WEBUI_GATES = String.raw`function gateVerdict(g, warns) {
  var verdict, cls;
  if (g.error) {
    verdict = 'probe failed';
    cls = 'bad';
    warns.push((g.link || '#' + g.pr) + ': ' + g.error);
  } else if (g.ok === false) {
    verdict = 'blocked';
    cls = 'bad';
  } else if (g.ok === true) {
    verdict = 'ok';
    cls = 'quiet';
  } else {
    verdict = '—';
  }
  return { verdict: verdict, cls: cls };
}

function gateCi(g) {
  if (g.ciPending === undefined && g.ciFailing === undefined) {
    return { ci: '—', cls: undefined };
  }
  var parts = [];
  if (g.ciFailing > 0) parts.push(g.ciFailing + ' failing');
  if (g.ciPending > 0) parts.push(g.ciPending + ' pending');
  if (g.reviewersPending > 0) parts.push(g.reviewersPending + ' reviewing');
  if (g.sastPending > 0) parts.push(g.sastPending + ' sast');
  var ci = parts.length === 0 ? 'ok' : parts.join(' · ');
  var cls = g.ciFailing > 0 ? 'bad' : (g.ciPending > 0 || g.reviewersPending > 0) ? 'warn' : undefined;
  return { ci: ci, cls: cls };
}

function renderGatePr(g, tr, warns) {
  var pr = el('td');
  appendPrLink(pr, g.link);
  tr.appendChild(pr);
  var v = gateVerdict(g, warns);
  tr.appendChild(el('td', v.verdict, v.cls));
  var mergeable = g.mergeable === undefined
    ? '—'
    : g.mergeable.toLowerCase() + (g.mergeState && g.mergeState !== 'CLEAN' ? ' · ' + g.mergeState.toLowerCase() : '');
  tr.appendChild(el('td', mergeable, g.mergeable === 'CONFLICTING' ? 'bad' : (g.mergeState === 'BEHIND' ? 'warn' : undefined)));
  tr.appendChild(el('td', g.openThreads === undefined ? '—' : String(g.openThreads), g.openThreads > 0 ? 'bad' : undefined));
  var ci = gateCi(g);
  tr.appendChild(el('td', ci.ci, ci.cls));
  tr.appendChild(el('td', (g.blockers || []).join('; ') || '—', (g.blockers || []).length > 0 ? 'warn' : 'muted'));
  (g.alerts || []).forEach(function (a) { warns.push((g.link || '#' + g.pr) + ': ' + a); });
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
      renderGatePr(g, tr, warns);
      tbody.appendChild(tr);
    });
    (gates.lookupErrors || []).forEach(function (e) { warns.push(e); });
  }
  list(document.getElementById('gatewarn'), warns, 'warn');
}

`;
