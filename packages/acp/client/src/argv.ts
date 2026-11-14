/**
 * argv words — a command line split into argv, with NO shell.
 *
 * The agent command is operator-authored config, so it meets a shell
 * line the way the providers' own `command` does: the trust contract
 * is the CONFIG, not the data. What this parser must never do is
 * re-interpret the text into a DIFFERENT program — so no `$`
 * expansion, no globs, no `;`/`|`/`&&`. Quotes and escapes are
 * honored; everything else is a literal word.
 *
 * An unclosed quote is a config error, named as such — never a
 * half-parsed command.
 */

/** One word's pieces — the literal text and whether it was quoted. */
export interface Word {
  text: string;
  quoted: boolean;
}

/**
 * The command's segments: a CLOSED quoted span, an escaped char, a
 * bare run, or whitespace (the word boundary).
 *
 * Only CLOSED quotes match — an unterminated one is left in the gap
 * between the segments, which is how `splitArgv` names it a config
 * error instead of half-parsing the command.
 */
const SEGMENT = /"(?:\\.|[^"\\])*"|'[^']*'|\\.|[^\s'"\\]+|\s+/g;

/** Does this leftover text hold a quote nobody closed? */
const hasQuote = (text: string): boolean => text.includes('"') || text.includes("'");

/** One segment's literal text — the quotes come off, the escapes stay. */
function decodeSegment(segment: string): Word {
  if (segment.startsWith('"')) {
    // a double-quoted span: the backslash escapes the next char
    return { text: segment.slice(1, -1).replace(/\\(.)/g, '$1'), quoted: true };
  }
  if (segment.startsWith("'")) {
    // a single-quoted span: everything inside is literal (the shell's
    // own rule)
    return { text: segment.slice(1, -1), quoted: true };
  }
  if (segment.startsWith('\\')) {
    // an escaped char — the char itself, whatever it is
    return { text: segment.slice(1), quoted: false };
  }
  return { text: segment, quoted: false };
}

/**
 * Split a command line into argv words, plus whether each came from
 * a quoted span — a quoted word is DATA, an unquoted one is also
 * data, but a caller that cares about the difference (an operator's
 * own quoting) can ask.
 */
export function splitArgvDetailed(command: string): Word[] {
  const words: Word[] = [];
  let cur = '';
  let quoted = false;
  let started = false;
  let consumed = 0;

  for (const match of command.matchAll(SEGMENT)) {
    const gap = command.slice(consumed, match.index);
    if (hasQuote(gap)) throw new Error('unclosed quote');
    consumed = match.index + match[0].length;
    const segment = match[0];
    if (/^\s+$/.test(segment)) {
      // the word boundary
      if (started) {
        words.push({ text: cur, quoted });
        cur = '';
        quoted = false;
        started = false;
      }
      continue;
    }
    const decoded = decodeSegment(segment);
    cur += decoded.text;
    quoted = quoted || decoded.quoted;
    started = true;
  }
  const tail = command.slice(consumed);
  if (hasQuote(tail)) throw new Error('unclosed quote');
  if (started) words.push({ text: cur, quoted });
  return words;
}

/** Split a command line into argv words — no expansion, ever. */
export function splitArgv(command: string): string[] {
  return splitArgvDetailed(command).map(w => w.text);
}
