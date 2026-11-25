/** JSONC parsing helpers for devcontainer descriptors. */
/** Index after the `// …` comment starting at i (no newline consumed). */
export function jsoncSkipLineComment(text: string, i: number): number {
  let k = i;
  while (k < text.length && text[k] !== '\n') {
    k++;
  }
  return k;
}

/** Index after the `/* … *\/` comment starting at i. */
export function jsoncSkipBlockComment(text: string, i: number): number {
  let k = i + 2;
  while (k < text.length && !(text[k] === '*' && text[k + 1] === '/')) {
    k++;
  }
  return Math.min(k + 2, text.length);
}

/** Whitespace AND comments — the trivia a trailing-comma lookahead
 *  skips: `{a:1, /* c *\/ }` is legal JSONC, so a `}` may hide behind
 *  a comment, not just whitespace. */
export function jsoncSkipTrivia(text: string, i: number): number {
  let k = i;
  for (;;) {
    while (k < text.length && /\s/.test(text[k]!)) {
      k++;
    }
    if (text.slice(k, k + 2) === '//') {
      k = jsoncSkipLineComment(text, k);
    } else if (text.slice(k, k + 2) === '/*') {
      k = jsoncSkipBlockComment(text, k);
    } else {
      return k;
    }
  }
}

/** Copy the string literal starting at i verbatim — escapes included —
 *  into out; returns the index after its closing quote. A `//` or a
 *  `,]` inside a string is content, never comment or comma. */
export function jsoncCopyString(text: string, i: number, out: string[]): number {
  out.push('"'); // the opening quote — closing-quote detection starts one char in
  let k = i + 1;
  while (k < text.length) {
    const c = text[k]!;
    out.push(c);
    k++;
    if (c === '\\' && k < text.length) {
      out.push(text[k]!);
      k++;
    } else if (c === '"') {
      return k;
    }
  }
  return k;
}

/** devcontainer.json is commented JSON — // and /* … *\/ comments plus
 *  trailing commas are legal there and illegal to JSON.parse. The
 *  scanner copies significant chars only, tracking string state so a
 *  `//` inside a URL or a `,]` inside a string survives verbatim. */
export function jsoncToJson(text: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    i = jsoncCopyNext(text, i, out);
  }
  return out.join('');
}

function jsoncCopyNext(text: string, i: number, out: string[]): number {
  const c = text[i]!;
  const pair = text.slice(i, i + 2);
  if (c === '"') return jsoncCopyString(text, i, out);
  if (pair === '//') return jsoncSkipLineComment(text, i);
  if (pair === '/*') return jsoncSkipBlockComment(text, i);
  if (c === ',' && jsoncHasTrailingComma(text, i)) return i + 1;
  out.push(c);
  return i + 1;
}

function jsoncHasTrailingComma(text: string, i: number): boolean {
  const next = text[jsoncSkipTrivia(text, i + 1)];
  return next === '}' || next === ']';
}
