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
 *
 * The parse is a SCAN, not a regex: a regex over quoted spans has a
 * polynomial backtracking path (CodeQL's `js/polynomial-redos`), and
 * the operator's config is exactly the kind of text that finds it.
 */

/** One word's pieces — the literal text and whether it was quoted. */
export interface Word {
  text: string;
  quoted: boolean;
}

/** A piece of the command read out of it, and where it ended. */
interface Piece {
  text: string;
  quoted: boolean;
  next: number;
}

/** Is this char a word boundary? */
const isSpace = (ch: string): boolean => /\s/.test(ch);

/**
 * The char an escape protects, and where the escape ends.
 *
 * `undefined` when the backslash protects NOTHING — the end of the
 * command, or a newline (the shell's line continuation, dropped
 * here: it is a whitespace boundary either way).
 */
function escapedChar(command: string, at: number): { char: string; next: number } | undefined {
  const next = command[at + 1];
  if (next === undefined || next === '\n') return undefined;
  return { char: next, next: at + 2 };
}

/**
 * Read a double-quoted span: the backslash escapes the next char, the
 * closing quote ends the span.
 *
 * An unclosed span is a config error — including the one the escape
 * makes: a backslash at the end of the command protects nothing, so
 * the quote it sits in was never closed.
 */
function readDoubleQuoted(command: string, start: number): Piece {
  let text = '';
  let i = start + 1;
  while (i < command.length) {
    const ch = command[i]!;
    if (ch === '"') return { text, quoted: true, next: i + 1 };
    if (ch === '\\') {
      const esc = escapedChar(command, i);
      if (esc === undefined) throw new Error('unclosed quote');
      text += esc.char;
      i = esc.next;
      continue;
    }
    text += ch;
    i += 1;
  }
  throw new Error('unclosed quote');
}

/**
 * Read a single-quoted span: everything inside is literal, backslashes
 * included — the shell's own rule.
 */
function readSingleQuoted(command: string, start: number): Piece {
  const end = command.indexOf("'", start + 1);
  if (end === -1) throw new Error('unclosed quote');
  return { text: command.slice(start + 1, end), quoted: true, next: end + 1 };
}

/**
 * The next piece of the command at `at` — a quoted span, an escaped
 * char, or a bare char.
 */
function nextPiece(command: string, at: number): Piece {
  const ch = command[at]!;
  if (ch === '"') return readDoubleQuoted(command, at);
  if (ch === "'") return readSingleQuoted(command, at);
  if (ch === '\\') {
    const esc = escapedChar(command, at);
    // an escape that protects nothing is dropped — the shell's rule
    // for a trailing backslash
    return esc === undefined
      ? { text: '', quoted: false, next: at + 1 }
      : { text: esc.char, quoted: false, next: esc.next };
  }
  return { text: ch, quoted: false, next: at + 1 };
}

/**
 * Read one word — everything up to the next whitespace, with the
 * quoted spans inside it unwrapped.
 *
 * `null` when the word was never really there (a lone trailing
 * backslash): the old regex split left it out, and so do we.
 */
function readWord(command: string, start: number): { word: Word | null; next: number } {
  let text = '';
  let quoted = false;
  let touched = false;
  let i = start;
  while (i < command.length && !isSpace(command[i]!)) {
    const piece = nextPiece(command, i);
    if (piece.text !== '' || piece.quoted) touched = true;
    text += piece.text;
    quoted = quoted || piece.quoted;
    i = piece.next;
  }
  return { word: touched ? { text, quoted } : null, next: i };
}

/**
 * Split a command line into argv words, plus whether each came from
 * a quoted span — a quoted word is DATA, an unquoted one is also
 * data, but a caller that cares about the difference (an operator's
 * own quoting) can ask.
 */
export function splitArgvDetailed(command: string): Word[] {
  const words: Word[] = [];
  let i = 0;
  while (i < command.length) {
    // the word boundary
    while (i < command.length && isSpace(command[i]!)) i += 1;
    if (i >= command.length) break;
    const read = readWord(command, i);
    if (read.word !== null) words.push(read.word);
    i = read.next;
  }
  return words;
}

/** Split a command line into argv words — no expansion, ever. */
export function splitArgv(command: string): string[] {
  return splitArgvDetailed(command).map(w => w.text);
}
