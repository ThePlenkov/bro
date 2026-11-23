/**
 * Reading a shell command — the parts of it the cap's grammar needs.
 *
 * The scan reads a command the way a shell would: the split happens
 * OUTSIDE quotes (a prompt may contain `;`), a quoted run is ONE token
 * (`bro --command 'devin acp'` names a command, it does not start one),
 * and an environment assignment in front of a binary does not make the
 * binary an argument.
 */

/** A shell token — its text and whether it was quoted. */
export interface Token {
  text: string;
  quoted: boolean;
  /** The index in `text` where literal (quoted or escaped) text begins —
   *  undefined when the whole word is raw. Operator characters must sit
   *  BEFORE it: `'>'x` and `\>x` are words named `>x`, `<<'E'` is a real
   *  heredoc (the op is raw, only the delimiter was quoted). */
  literalAt?: number;
}

/** The basename of a path-like token. */
export function base(token: Token): string {
  return token.text.slice(token.text.lastIndexOf('/') + 1);
}

/** The shell keywords that sit where a command sits (`then devin …`) —
 *  they are not commands themselves. `if`/`while`/`until`/`!` belong:
 *  their follower is a command the shell RUNS (the condition — `if
 *  devin; then …` launches devin). `for`/`case`/`in`/`[[` do not —
 *  their follower is a variable or a pattern, and naming the keyword
 *  itself (inert) beats misreading the word behind it as a command. */
const SHELL_KEYWORDS = new Set([
  '!',
  'do',
  'done',
  'else',
  'elif',
  'fi',
  'if',
  'then',
  'until',
  'while',
  '{',
  '}',
]);

/** Is this token an environment assignment (`FOO=bar`)? The `=` must be
 *  raw — `FOO\=bar` is a word named `FOO=bar`, not an assignment — and
 *  so must the name: `F\OO=bar` runs a command, it assigns nothing. */
export function isAssignment(token: Token): boolean {
  const match = /^[A-Za-z_][A-Za-z0-9_]*=/.exec(token.text);
  if (match === null) {
    return false;
  }
  // the `=` is the last char of the match — quoting or escaping inside
  // the name OR on the `=` itself demotes the word to a command
  return token.literalAt === undefined || token.literalAt > match[0].length - 1;
}

/** The characters that end a shell segment. `(`/`)` are operators too —
 *  `(devin -p x) & wait` runs devin inside the subshell group, and the
 *  split costs nothing elsewhere: `$(…)`/`<(…)` substitutions DO run
 *  their innards, and arithmetic/`case`-pattern residue is an inert
 *  cli name. Quoted or escaped parens stay word text. */
const SEPARATORS = new Set([';', '&', '|', '\n', '(', ')']);

/** Is the character at `i` escaped — preceded by an ODD run of
 *  backslashes (`\>` is literal text; `\\>` is a backslash then a real
 *  operator)? */
function isEscaped(command: string, i: number): boolean {
  let backslashes = 0;
  for (let j = i - 1; j >= 0 && command.charAt(j) === '\\'; j--) {
    backslashes++;
  }
  return backslashes % 2 === 1;
}

/** Is the separator at `i` actually the tail of a redirect operator
 *  rather than a command boundary? `>&`/`<&` duplicate a descriptor,
 *  `&>`/`&>>` fold stdout and stderr into one redirect and `>|` is the
 *  noclobber write — `devin -p x 2>&1` is ONE command whose `1`
 *  launches nothing. The angle must be a real operator char though:
 *  `\>&` is an escaped `>` then a background `&` (`echo \>& devin -p x`
 *  RUNS devin), and the second `&` of `&&` starts a redirect-free
 *  clause (`true &&>/dev/null devin -p x` is `&&` then `>`, so devin
 *  runs too). A standalone `&` (and `|&`, the stderr pipeline) still
 *  separates. */
function isOperatorGlue(command: string, i: number): boolean {
  const ch = command.charAt(i);
  const prev = command.charAt(i - 1);
  // `>&`/`<&` dup and `>|` noclobber — the tail char of a redirect op,
  // only when the angle itself is unescaped
  if ((prev === '>' && (ch === '&' || ch === '|')) || (prev === '<' && ch === '&')) {
    return !isEscaped(command, i - 1);
  }
  // `&>`/`&>>` fold — never the second `&` of `&&`
  return ch === '&' && command.charAt(i + 1) === '>' && prev !== '&';
}

/** The quote characters. */
const QUOTES = new Set(['"', "'"]);

/** A pending here-document — the `<<`/`<<-` op a line carried and the
 *  delimiter its body ends on. The body lines are DATA to the command
 *  they feed (`cat <<EOF` swallows every line until `EOF`), so a line
 *  reading like a launch inside one (`worker-cli run`) is no command.
 *  `<<<` is a herestring — ONE word of data, no body lines. */
interface Heredoc {
  /** the word the body ends on — quotes and escapes stripped, the way
   *  the shell compares body lines */
  delimiter: string;
  /** `<<-` folds leading tabs out of the body and the delimiter line */
  stripTabs: boolean;
}

/** The heredoc op at `i` (`<<` or `<<-`, never `<<<`) — its delimiter
 *  word and the index past it. Returns undefined when no word follows
 *  (a syntax error the shell itself refuses — nothing to queue). */
function heredocAt(command: string, i: number): { hd: Heredoc; end: number } | undefined {
  let j = i + 2;
  const stripTabs = command.charAt(j) === '-';
  if (stripTabs) {
    j++;
  }
  while (command.charAt(j) === ' ' || command.charAt(j) === '\t') {
    j++;
  }
  let delimiter = '';
  let started = false;
  for (; j < command.length; j++) {
    const c = command.charAt(j);
    if (/\s/.test(c) || SEPARATORS.has(c) || c === '<' || c === '>' || c === '(' || c === ')') {
      break;
    }
    if (c === '#' && !started) {
      break; // a comment, not a delimiter word
    }
    started = true;
    if (QUOTES.has(c)) {
      // a quoted run inside the delimiter — the quotes are NOT part of
      // the word the body lines must equal. Inside DOUBLE quotes bash's
      // own escapes still decode (`\"` is a literal quote, never the
      // close — `<<"E\"OF"` delimits on E"OF, not E\); a single-quoted
      // run decodes nothing. An unterminated run eats the rest — the
      // shell itself refuses it, nothing to queue.
      let k = j + 1;
      let closed = false;
      while (k < command.length) {
        const d = command.charAt(k);
        if (d === c) {
          closed = true;
          break;
        }
        if (c === '"' && d === '\\' && k + 1 < command.length) {
          const e = command.charAt(k + 1);
          if (e === '"' || e === '\\' || e === '$' || e === '`') {
            delimiter += e;
            k += 2;
            continue;
          }
          if (e === '\n') {
            k += 2; // a continuation — the pair vanishes
            continue;
          }
        }
        delimiter += d;
        k++;
      }
      if (!closed) {
        j = command.length;
        break;
      }
      j = k;
      continue;
    }
    if (c === '\\' && j + 1 < command.length) {
      delimiter += command.charAt(++j);
      continue;
    }
    delimiter += c;
  }
  return started ? { hd: { delimiter, stripTabs }, end: j } : undefined;
}

/** One heredoc's body — lines until the delimiter line (tabs folded
 *  for `<<-`). Returns the body text plus the index of the newline
 *  that ENDS the delimiter line, or the input's end when the body
 *  never terminates. */
function heredocBody(command: string, from: number, hd: Heredoc): { body: string; end: number } {
  let i = from;
  while (i < command.length) {
    const nl = command.indexOf('\n', i);
    const end = nl === -1 ? command.length : nl;
    const line = command.slice(i, end);
    if ((hd.stripTabs ? line.replace(/^\t+/, '') : line) === hd.delimiter) {
      return { body: command.slice(from, i), end };
    }
    if (nl === -1) {
      return { body: command.slice(from), end: command.length };
    }
    i = nl + 1;
  }
  return { body: command.slice(from), end: i };
}

/** The shell segments of a command — the split happens OUTSIDE quotes,
 *  the way a shell would. An unquoted `#` that STARTS a word opens a
 *  shell comment: the rest of the line is text, not a command (`devin
 *  a # note; devin b` runs `devin a` alone — the `;` inside the
 *  comment splits nothing). A `#` inside a word or a quote stays text
 *  (`devin -p '#tag'`, `a#b`) — and so does a `#` behind an ESCAPE: an
 *  escaped char is word text wherever it lands, so `\ ` keeps the word
 *  open and `echo \ #; devin x` still runs `devin`. The lines a
 *  here-document redirects never scan as segments — they are their
 *  command's own stdin (data to `cat <<EOF`, the PROGRAM to `sh
 *  <<EOF`), so each body stays attached to the segment whose `<<`
 *  wrote it and the caller tells the two apart. */
export interface Segment {
  text: string;
  /** The here-document bodies queued on this segment's command — in
   *  op order when one line queues several (`cat <<A <<B`). */
  bodies: string[];
}

export function scanSegments(command: string): Segment[] {
  const out: Segment[] = [];
  let current = '';
  let quote: string | null = null;
  let comment = false;
  // the heredoc ops this line queued — their bodies arrive AFTER the
  // line's newline, in op order, each owned by the segment index its
  // `<<` sits in (`current` lands at out.length when next pushed)
  const heredocs: { hd: Heredoc; seg: number }[] = [];
  // mid-word: a `#` opens a comment only at a word's START — after
  // whitespace, a separator, or nothing. An escaped char is word text
  // even when it IS whitespace (`\ ` continues the word).
  let inWord = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command.charAt(i);
    if (comment) {
      // the comment runs to the newline — which is itself a
      // separator, so scanning resumes as if it were never written
      if (ch !== '\n') {
        continue;
      }
      comment = false;
    }
    if (quote !== null) {
      current += ch;
      if (quote === '"' && ch === '\\' && i + 1 < command.length) {
        // `\"` inside a double-quoted run is an escape — the quote
        // stays inside the string (the escape `tokens` reads too)
        current += command.charAt(++i);
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '\\') {
      // `\<newline>` is a line CONTINUATION — the pair vanishes and the
      // lines join, so `cd /tmp && \`␤`devin -p x` runs `devin` (and a
      // `dev\<newline>in` word keeps its inWord state). Any other
      // escaped char is word text — `\;` separates nothing, and `\ `
      // keeps the word open so a `#` behind it is an argument
      if (command.charAt(i + 1) === '\n') {
        i++;
        continue;
      }
      current += ch;
      if (i + 1 < command.length) {
        current += command.charAt(++i);
      }
      inWord = true;
      continue;
    }
    if (QUOTES.has(ch)) {
      quote = ch;
      current += ch;
      inWord = true;
      continue;
    }
    if (ch === '#' && !inWord) {
      comment = true;
      continue;
    }
    if (
      ch === '<' &&
      command.charAt(i + 1) === '<' &&
      command.charAt(i - 1) !== '<' &&
      command.charAt(i + 2) !== '<'
    ) {
      const found = heredocAt(command, i);
      if (found !== undefined) {
        heredocs.push({ hd: found.hd, seg: out.length });
        current += command.slice(i, found.end);
        i = found.end - 1;
        continue;
      }
    }
    if (SEPARATORS.has(ch) && !isOperatorGlue(command, i)) {
      out.push({ text: current, bodies: [] });
      current = '';
      inWord = false;
      if (ch === '\n' && heredocs.length > 0) {
        // the queued bodies are this line's stdin — never segments of
        // their own; scanning resumes after the LAST delimiter. Each
        // lands on the segment its `<<` sat in — the push above made
        // every one of them already exist.
        let at = i + 1;
        for (const { hd, seg } of heredocs) {
          const got = heredocBody(command, at, hd);
          out.at(seg)?.bodies.push(got.body);
          at = got.end + 1;
          i = got.end;
        }
        heredocs.length = 0;
      }
      continue;
    }
    current += ch;
    inWord = !/\s/.test(ch);
  }
  out.push({ text: current, bodies: [] });
  return out.map(s => ({ text: s.text.trim(), bodies: s.bodies })).filter(s => s.text !== '');
}

/** The segment texts alone — the pre-bodies shape kept for callers
 *  that never read a heredoc's payload. */
export function segments(command: string): string[] {
  return scanSegments(command).map(s => s.text);
}

/** The tokens of a shell segment, quotes honoured — a quoted run is ONE
 *  token. A `\"` inside a double-quoted run is an escape — the quote
 *  stays inside the string (`sh -c "sh -c \"devin\""` carries one
 *  script). An unquoted `\x` decodes the way the shell would — the `x`
 *  is literal word text and the word does not break on it: `sh -c
 *  worker-cli\ run` hands `-c` the ONE operand `worker-cli run`, and
 *  `\>` is a literal `>` (word text), never a redirect op. */
export function tokens(segment: string): Token[] {
  const out: Token[] = [];
  let current = '';
  let quoted = false;
  let quote: string | null = null;
  // the index in `current` where literal text began — quoted or
  // escaped chars never read as operators (`'>'`, `\>` are word text)
  let literalAt: number | undefined;
  const literal = (): void => {
    literalAt ??= current.length;
  };
  for (let i = 0; i < segment.length; i++) {
    const ch = segment.charAt(i);
    if (quote !== null) {
      // only the MATCHING quote closes the run — an apostrophe inside
      // a double-quoted run is text
      if (ch === quote) {
        quote = null;
        continue;
      }
      if (quote === '"' && ch === '\\' && i + 1 < segment.length) {
        const next = segment.charAt(i + 1);
        // inside a double-quoted run `\` escapes only `$`, '`', '"',
        // `\` and a newline (a continuation — the pair vanishes). Any
        // other `\x` stays BOTH chars — `bash -c "a\;b"` hands the
        // inner shell `a\;b`, whose own escape keeps `b` an argument
        if (next === '\n') {
          i++;
          continue;
        }
        if (next === '"' || next === '\\' || next === '$' || next === '`') {
          current += next;
          i++;
          continue;
        }
        current += ch;
        continue;
      }
      current += ch;
      continue;
    }
    if (QUOTES.has(ch)) {
      quote = ch;
      quoted = true;
      literal();
      continue;
    }
    if (ch === '\\') {
      // the escaped char is literal word text — `\ ` glues the halves
      // around it into ONE operand (`sh -c worker-cli\ run`), `\<newline>`
      // vanishes (a continuation — `segments` drops it first anyway)
      literal();
      if (i + 1 < segment.length) {
        const next = segment.charAt(++i);
        if (next !== '\n') {
          current += next;
        }
      }
      continue;
    }
    if (/\s/.test(ch)) {
      out.push(...token(current, quoted, literalAt));
      current = '';
      quoted = false;
      literalAt = undefined;
      continue;
    }
    if (ch === '<' || ch === '>' || (ch === '&' && segment.charAt(i + 1) === '>')) {
      // an unquoted redirection starts mid-word too — `worker-cli>log
      // run` launches `worker-cli`. The word ends here UNLESS the
      // char continues an op run (`>>`, `&>` — the tail stays glued
      // only while it stayed raw) or the word so far is a bare fd
      // number (`2>err` rebinds fd 2 — `2` is the op's own prefix,
      // not a word). Quoted and escaped angles never reach this
      // branch — they are word text above.
      const tail = current.length - 1;
      const continuesOp =
        tail >= 0 &&
        /[<>&]/.test(current.charAt(tail)) &&
        (literalAt === undefined || literalAt > tail);
      const fdPrefix = literalAt === undefined && /^\d+$/.test(current);
      if (current !== '' && !continuesOp && !fdPrefix) {
        out.push(...token(current, quoted, literalAt));
        current = '';
        quoted = false;
        literalAt = undefined;
      }
      current += ch;
      continue;
    }
    current += ch;
  }
  out.push(...token(current, quoted, literalAt));
  return out;
}

/** One token — an empty run is no token at all, UNLESS it was quoted:
 *  `bash -c '' devin` runs an EMPTY script with `devin` as its $0, so
 *  dropping the '' would read `devin` as the -c operand — a launch
 *  that never happens. */
function token(text: string, quoted: boolean, literalAt: number | undefined): Token[] {
  const t: Token = { text, quoted, ...(literalAt === undefined ? {} : { literalAt }) };
  return text === '' ? (quoted ? [t] : []) : [t];
}

/** The wrappers that take a bare operand before the command
 *  (`timeout 30 devin`). */
const WRAPPER_OPERANDS = new Set(['chrt', 'stdbuf', 'taskset', 'timeout']);

/** The options that take a value (`sudo -u root`, `nice -n 5`) — the
 *  value is not the command. */
const VALUE_OPTIONS = new Set(['-U', '-c', '-m', '-n', '-o', '-u']);

/** The wrappers a binary may sit behind — the token before the binary
 *  decides whether the binary is a command or an argument. */
const WRAPPERS = new Set([
  'bunx',
  'chrt',
  'command',
  'env',
  'exec',
  'ionice',
  'nice',
  'nohup',
  'npx',
  'pnpm',
  'setsid',
  'stdbuf',
  'sudo',
  'taskset',
  'time',
  'timeout',
  'xargs',
  'yarn',
]);

/** A leading redirect operator — `[n]<op>[word]` or `&>`/`&>>`. The
 *  alternation is longest-first so `<<<` (herestring), `<<-` and `<>`
 *  never read as their prefixes, and `>&` never reads as `>` + glued
 *  `&` (a bare `>&` still needs its word in the NEXT token). */
const REDIRECT_OP = /^(&>>?|\d*(?:<<<|<<-|<<|<&|<>|>>&|>>|>&|>\||>|<))/;

/** The token indexes redirection spends — the operator tokens plus the
 *  detached target word a bare op takes from the NEXT token (`> log`
 *  spends `log` on the file, it is not the command). A token whose
 *  operator chars were quoted or escaped is a WORD (`'>'x`, `\>x`,
 *  `2\>x` — `literalAt` marks where raw text ended); a redirect it
 *  leads can itself carry quoting (`<<'EOF'`). */
export function redirectIndexes(toks: Token[]): Set<number> {
  const skip = new Set<number>();
  for (let i = 0; i < toks.length; i++) {
    const t = toks.at(i);
    if (t === undefined) {
      continue;
    }
    const match = REDIRECT_OP.exec(t.text);
    if (match === null || (t.literalAt !== undefined && match[0].length > t.literalAt)) {
      continue;
    }
    skip.add(i);
    if (match[0].length === t.text.length && t.literalAt === undefined) {
      // the op's word sits in the next token — it is spent on the
      // target (file, fd, heredoc delimiter), never re-examined. A
      // literal run glued to the op IS the operand already — `<<<''`
      // carries an empty here-string (`literalAt` marks where it
      // starts), so `devin <<<'' list` keeps `list` an argument.
      skip.add(++i);
    }
  }
  return skip;
}

/** The index of the segment's command — the assignments, the
 *  redirections and the wrappers (with their options, their values and
 *  the operand some of them take) are skipped; what is left is the
 *  command. A redirect-first command still names its binary —
 *  `>run.log worker-cli run` launches `worker-cli`. */
export function commandIndex(toks: Token[]): number {
  const skip = redirectIndexes(toks);
  let i = 0;
  while (i < toks.length) {
    const token = toks.at(i);
    if (token === undefined || skip.has(i) || isSkipped(token)) {
      i++;
      continue;
    }
    const name = base(token);
    if (!WRAPPERS.has(name)) {
      return i;
    }
    if (isLookup(toks, i, skip)) {
      // `command -v devin` LOOKS the binary up — it does not run it
      return i;
    }
    i = skipWrapperArgs(toks, i + 1, token, skip);
  }
  return i;
}

/** Is this token skipped on the way to the command? An assignment and
 *  a shell keyword are not commands. */
function isSkipped(token: Token): boolean {
  return isAssignment(token) || SHELL_KEYWORDS.has(token.text);
}

/** Is this wrapper a lookup (`command -v X`) rather than a runner?
 *  Redirects interleave freely — `command >log -v devin` still looks
 *  `devin` up, it runs nothing. */
function isLookup(toks: Token[], at: number, skip: ReadonlySet<number>): boolean {
  if (base(toks.at(at) as Token) !== 'command') {
    return false;
  }
  let flagAt = at + 1;
  while (skip.has(flagAt)) {
    flagAt++;
  }
  const flag = toks.at(flagAt)?.text;
  return flag === '-v' || flag === '-V';
}

/** The index after a wrapper's own arguments — its options (with the
 *  value some of them take), the operand some of them need, and the
 *  redirections interleaved between them (`timeout >log 30 devin`
 *  still runs `devin`). */
function skipWrapperArgs(
  toks: Token[],
  from: number,
  wrapper: Token,
  skip: ReadonlySet<number>
): number {
  let i = from;
  let operands = WRAPPER_OPERANDS.has(base(wrapper)) ? 1 : 0;
  let optionsDone = false;
  while (i < toks.length) {
    if (skip.has(i)) {
      i++;
      continue;
    }
    const next = toks.at(i);
    if (next === undefined) {
      break;
    }
    if (!optionsDone && next.text === '--') {
      // options end — a `-…` word behind `--` is the operand/command
      optionsDone = true;
      i++;
      continue;
    }
    if (!optionsDone && next.text.startsWith('-')) {
      i = skipOption(toks, i, next);
      continue;
    }
    if (operands > 0) {
      operands--;
      i++;
      continue;
    }
    break;
  }
  return i;
}

/** The index after an option — with the value it takes, if any. */
function skipOption(toks: Token[], at: number, option: Token): number {
  const next = at + 1;
  return optionTakesNext(toks, next, option) ? next + 1 : next;
}

/** Does this option take the next token as its value? */
function optionTakesNext(toks: Token[], at: number, option: Token): boolean {
  if (!VALUE_OPTIONS.has(option.text)) {
    return false;
  }
  const next = toks.at(at);
  return next !== undefined && !next.text.startsWith('-');
}

/** Is the token at this position a command (not an argument)? */
export function atCommandPosition(toks: Token[], at: number): boolean {
  return at === commandIndex(toks);
}

/** The shells whose `-c` argument is a command of its own — the
 *  script's own commands are the launches, not the shell's. */
const COMMAND_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);

/** Is this the shell's command flag? `-c` alone, or a combined short
 *  flag that carries it (`-lc`, `-ic`). */
function isShellCommandFlag(flag: string | undefined): boolean {
  if (flag === undefined) {
    return false;
  }
  if (flag === '-c') {
    return true;
  }
  // a combined short flag that carries the command ('-lc', '-ic') —
  // read as letters, not as a polynomial pattern
  if (!flag.startsWith('-') || flag.length < 2) {
    return false;
  }
  const letters = flag.slice(1);
  return letters.includes('c') && /^[a-z]+$/.test(letters);
}

/** The shell options that consume the NEXT token as their value —
 *  the value is the option's operand, never the script (`bash -o
 *  errexit -c 'x'`). A combined short flag ENDING in o/O takes one
 *  too (`bash -lo errexit -c 'x'`). */
const SHELL_VALUE_OPTION = /^[-+][a-zA-Z]*[oO]$/;

/** The command a shell wrapper runs: `sh -c 'devin -p x'` — the string
 *  is a command of its own, so its own reading applies. Options ahead
 *  of `-c` scan as options (`bash -l -c 'x'` reads like `bash -lc
 *  'x'`); the first bare operand ends them — `bash script.sh` runs a
 *  FILE, not a command line, and a `-c` after it is the script's own
 *  argument. The `-c` operand itself reads bare or quoted (`bash -c
 *  devin` runs `devin`) — later positionals stay the script's $0/args,
 *  never part of it. */
export function wrappedCommand(toks: Token[]): string | undefined {
  const at = commandIndex(toks);
  const shell = toks.at(at);
  if (shell === undefined || !COMMAND_SHELLS.has(base(shell))) {
    return undefined;
  }
  // a redirect is the shell's own plumbing, not an operand —
  // `sh >log -c 'devin x'` still runs the script
  const skip = redirectIndexes(toks);
  for (let i = at + 1; i < toks.length; i++) {
    if (skip.has(i)) {
      continue;
    }
    const flag = toks.at(i)?.text ?? '';
    if (isShellCommandFlag(flag)) {
      // the -c operand, bare or quoted — later positionals are its args
      // (a redirect between flag and script is the shell's own plumbing)
      let operand = i + 1;
      while (skip.has(operand)) {
        operand++;
      }
      return toks.at(operand)?.text;
    }
    if (flag === '--') {
      return undefined; // options end — what follows is a file operand
    }
    if (SHELL_VALUE_OPTION.test(flag)) {
      i++; // the option's own value — not the command
      while (skip.has(i)) {
        i++; // a redirect in between is not the value either
      }
      continue;
    }
    if (flag.length > 1 && (flag.startsWith('-') || flag.startsWith('+'))) {
      continue; // a flag that carries no separate value — keep scanning
    }
    return undefined; // the first operand — a file, not a -c script
  }
  return undefined;
}

/** Is this shell's program its stdin? `sh <<EOF` runs the here-
 *  document body as a script where `cat <<EOF` swallows it as data —
 *  the heredoc's lines are commands only when a command-shell reads
 *  its program from stdin. A `-c` operand or a file operand supplies
 *  the program instead (the body is then the script's own stdin —
 *  data, like cat's), `-s` names the stdin program explicitly
 *  (operands after it are its $0/args), and `-`/`--` end the options
 *  — what follows is the script FILE. */
export function readsStdinScript(toks: Token[]): boolean {
  const at = commandIndex(toks);
  const shell = toks.at(at);
  if (shell === undefined || !COMMAND_SHELLS.has(base(shell))) {
    return false;
  }
  // a redirect is the shell's own plumbing, not an operand — the
  // `<<EOF` that queues the body sits in this skip set itself
  const skip = redirectIndexes(toks);
  let stdin = false; // `-s` passed — operands behind it are positional
  let optionsDone = false;
  for (let i = at + 1; i < toks.length; i++) {
    if (skip.has(i)) {
      continue;
    }
    const flag = toks.at(i)?.text ?? '';
    if (!optionsDone && (flag === '--' || flag === '-')) {
      optionsDone = true;
      continue;
    }
    if (!optionsDone && isShellCommandFlag(flag)) {
      return false; // a -c operand supplies the program
    }
    if (!optionsDone && SHELL_VALUE_OPTION.test(flag)) {
      i++; // the option's own value — not the program
      while (skip.has(i)) {
        i++;
      }
      continue;
    }
    if (!optionsDone && flag.length > 1 && (flag.startsWith('-') || flag.startsWith('+'))) {
      stdin ||= flag.includes('s');
      continue;
    }
    // a bare operand is the script FILE — the body is its stdin data
    return stdin;
  }
  return true;
}

/** How many `-c` layers a reader unwraps — deeper nesting is a string
 *  a prompt carries, not a wrapper a spawn wrote. */
export const MAX_WRAPPED_COMMAND_DEPTH = 2;

/** The cli names a command launches — the basename at every segment's
 *  command position (assignments and wrappers skipped), a shell's `-c`
 *  script recursed into. The same words the session planes count
 *  starts on: `sh -c 'devin -p x'` launches `devin`, `env V=1 nice -n 5
 *  timeout 30 devin` launches `devin`, and `sh -c 'echo devin'`
 *  launches `echo` — a provider named only as an argument is not a
 *  start. */
export function commandCliNames(command: string, depth = 0): string[] {
  const out: string[] = [];
  for (const segment of scanSegments(command)) {
    const toks = tokens(segment.text);
    const word = toks.at(commandIndex(toks));
    if (word === undefined || word.text === '') {
      // a quoted EMPTY command (`'' devin`) launches nothing a lane
      // can name — the bash verdict is "command not found"
      continue;
    }
    const wrapped = depth < MAX_WRAPPED_COMMAND_DEPTH ? wrappedCommand(toks) : undefined;
    if (wrapped !== undefined) {
      out.push(...commandCliNames(wrapped, depth + 1));
      continue;
    }
    // a here-document feeding a shell IS the program — `sh <<EOF`
    // reads its commands from the body. Feeding anything else it is
    // data (`cat <<EOF`) the launch count never sees. The body counts
    // against the same depth budget as a -c script — it is the same
    // class of wrap.
    if (segment.bodies.length > 0 && depth < MAX_WRAPPED_COMMAND_DEPTH && readsStdinScript(toks)) {
      for (const body of segment.bodies) {
        out.push(...commandCliNames(body, depth + 1));
      }
      continue;
    }
    out.push(base(word));
  }
  return out;
}

/** The commands a template's scaffolding runs — POSIX builtins and the
 *  everyday utilities a spawn line's setup and teardown carry (`cd`,
 *  `echo`, `git pull`). One at a segment's command position is
 *  plumbing, never the tool a cap or a provider lane names itself by:
 *  `devin -p x; echo done` and `claude -p x; echo done` share `echo`,
 *  but `echo` opens no provider session. */
const SCAFFOLD_COMMANDS = new Set([
  // POSIX shell builtins
  '.',
  ':',
  '[',
  'alias',
  'bg',
  'cd',
  'command',
  'echo',
  'eval',
  'exec',
  'exit',
  'export',
  'false',
  'fc',
  'fg',
  'getopts',
  'hash',
  'jobs',
  'kill',
  'newgrp',
  'printf',
  'pwd',
  'read',
  'readonly',
  'return',
  'set',
  'shift',
  'source',
  'test',
  'times',
  'trap',
  'true',
  'type',
  'ulimit',
  'umask',
  'unalias',
  'unset',
  'wait',
  // the everyday utilities of setup/teardown
  'awk',
  'basename',
  'cat',
  'chmod',
  'chown',
  'cp',
  'cut',
  'date',
  'df',
  'dirname',
  'du',
  'find',
  'git',
  'grep',
  'gunzip',
  'gzip',
  'head',
  'hostname',
  'ln',
  'ls',
  'make',
  'mkdir',
  'mktemp',
  'mv',
  'ps',
  'readlink',
  'realpath',
  'rm',
  'rmdir',
  'rsync',
  'scp',
  'sed',
  'sleep',
  'sort',
  'ssh',
  'tail',
  'tar',
  'tee',
  'touch',
  'tr',
  'uname',
  'uniq',
  'wc',
  'which',
  'whoami',
]);

/** The cli names a command's WORK launches — `commandCliNames` minus
 *  the scaffolding commands a template runs around its worker. A
 *  command whose every cli is scaffolding keeps its full list — an
 *  exotic worker named like a builtin (`test`, `make`) still
 *  identifies itself. */
export function commandWorkerClis(command: string): string[] {
  const clis = commandCliNames(command);
  const workers = clis.filter(cli => !SCAFFOLD_COMMANDS.has(cli));
  return workers.length > 0 ? workers : clis;
}
