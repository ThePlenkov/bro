/** Script segment of the fleet webui's `FLEET_PAGE` — the live agent-log pane (spec bro-wwo7e) — `logLine`
 *  pinned-append + head trim, `openLog`/`closeLog`/`saveLogToken`
 *  owning the EventSource lifetime.
 *  Split out of webui.ts (the module was past the CodeScene
 *  file-size bar); the segments concatenate in script order so
 *  the served bytes are unchanged. Same template-literal rules:
 *  no backticks, no `${` sequences in the client JS.
 */
export const WEBUI_LOG = String.raw`// One appended line — pins to the bottom only while already near it,
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
    '/log?follow&lines=' + LOG_REPLAY + '&' +
    new URLSearchParams({ token: logToken }));
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

`;
