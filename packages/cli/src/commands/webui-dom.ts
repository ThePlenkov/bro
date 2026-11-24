/** Script segment of the fleet webui's `FLEET_PAGE` — the DOM/format helpers — `el`/`list`/`appendPrLink` for
 *  `textContent`-only rendering, `base`/`age` for path and age display.
 *  Split out of webui.ts (the module was past the CodeScene
 *  file-size bar); the segments concatenate in script order so
 *  the served bytes are unchanged. Same template-literal rules:
 *  no backticks, no `${` sequences in the client JS.
 */
export const WEBUI_DOM = String.raw`function el(tag, text, cls) {
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

`;
