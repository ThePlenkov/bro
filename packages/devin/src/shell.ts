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
}

/** The basename of a path-like token. */
export function base(token: Token): string {
  return token.text.slice(token.text.lastIndexOf('/') + 1);
}

/** The shell keywords that sit where a command sits (`then devin …`) —
 *  they are not commands themselves. */
const SHELL_KEYWORDS = new Set(['do', 'done', 'else', 'elif', 'fi', 'then', '{', '}']);

/** Is this token an environment assignment (`FOO=bar`)? */
export function isAssignment(token: Token): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token.text);
}

/** The characters that end a shell segment. */
const SEPARATORS = new Set([';', '&', '|', '\n']);

/** Is the `&` at `i` part of a redirection rather than a command
 *  separator? `>&`/`<&` duplicate a descriptor and `&>`/`&>>` fold
 *  stdout and stderr into one redirect — `devin -p x 2>&1` is ONE
 *  command whose `1` launches nothing. A standalone `&` (and `|&`,
 *  the stderr pipeline) still separates. */
function isRedirectAmp(command: string, i: number): boolean {
  return (
    command.charAt(i) === '&' &&
    (command.charAt(i - 1) === '>' ||
      command.charAt(i - 1) === '<' ||
      command.charAt(i + 1) === '>')
  );
}

/** The quote characters. */
const QUOTES = new Set(['"', "'"]);

/** The shell segments of a command — the split happens OUTSIDE quotes,
 *  the way a shell would. An unquoted `#` that STARTS a word opens a
 *  shell comment: the rest of the line is text, not a command (`devin
 *  a # note; devin b` runs `devin a` alone — the `;` inside the
 *  comment splits nothing). A `#` inside a word or a quote stays text
 *  (`devin -p '#tag'`, `a#b`) — and so does a `#` behind an ESCAPE: an
 *  escaped char is word text wherever it lands, so `\ ` keeps the word
 *  open and `echo \ #; devin x` still runs `devin`. */
export function segments(command: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: string | null = null;
  let comment = false;
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
    if (SEPARATORS.has(ch) && !isRedirectAmp(command, i)) {
      out.push(current);
      current = '';
      inWord = false;
      continue;
    }
    current += ch;
    inWord = !/\s/.test(ch);
  }
  out.push(current);
  return out.map(s => s.trim()).filter(s => s !== '');
}

/** The tokens of a shell segment, quotes honoured — a quoted run is ONE
 *  token. A `\"` inside a double-quoted run is an escape — the quote
 *  stays inside the string (`sh -c "sh -c \"devin\""` carries one
 *  script). */
export function tokens(segment: string): Token[] {
  const out: Token[] = [];
  let current = '';
  let quoted = false;
  let quote: string | null = null;
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
      continue;
    }
    if (/\s/.test(ch)) {
      out.push(...token(current, quoted));
      current = '';
      quoted = false;
      continue;
    }
    current += ch;
  }
  out.push(...token(current, quoted));
  return out;
}

/** One token — an empty run is no token at all, UNLESS it was quoted:
 *  `bash -c '' devin` runs an EMPTY script with `devin` as its $0, so
 *  dropping the '' would read `devin` as the -c operand — a launch
 *  that never happens. */
function token(text: string, quoted: boolean): Token[] {
  return text === '' ? (quoted ? [{ text, quoted }] : []) : [{ text, quoted }];
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

/** The index of the segment's command — the assignments and the
 *  wrappers (with their options, their values and the operand some of
 *  them take) are skipped; what is left is the command. */
export function commandIndex(toks: Token[]): number {
  let i = 0;
  while (i < toks.length) {
    const token = toks.at(i);
    if (token === undefined || isSkipped(token)) {
      i++;
      continue;
    }
    const name = base(token);
    if (!WRAPPERS.has(name)) {
      return i;
    }
    if (isLookup(toks, i)) {
      // `command -v devin` LOOKS the binary up — it does not run it
      return i;
    }
    i = skipWrapperArgs(toks, i + 1, token);
  }
  return i;
}

/** Is this token skipped on the way to the command? An assignment and
 *  a shell keyword are not commands. */
function isSkipped(token: Token): boolean {
  return isAssignment(token) || SHELL_KEYWORDS.has(token.text);
}

/** Is this wrapper a lookup (`command -v X`) rather than a runner? */
function isLookup(toks: Token[], at: number): boolean {
  if (base(toks.at(at) as Token) !== 'command') {
    return false;
  }
  const flag = toks.at(at + 1)?.text;
  return flag === '-v' || flag === '-V';
}

/** The index after a wrapper's own arguments — its options (with the
 *  value some of them take) and the operand some of them need. */
function skipWrapperArgs(toks: Token[], from: number, wrapper: Token): number {
  let i = from;
  let operands = WRAPPER_OPERANDS.has(base(wrapper)) ? 1 : 0;
  while (i < toks.length) {
    const next = toks.at(i);
    if (next === undefined) {
      break;
    }
    if (next.text.startsWith('-')) {
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
  for (let i = at + 1; i < toks.length; i++) {
    const flag = toks.at(i)?.text ?? '';
    if (isShellCommandFlag(flag)) {
      // the -c operand, bare or quoted — later positionals are its args
      return toks.at(i + 1)?.text;
    }
    if (flag === '--') {
      return undefined; // options end — what follows is a file operand
    }
    if (SHELL_VALUE_OPTION.test(flag)) {
      i++; // the option's own value — not the command
      continue;
    }
    if (flag.length > 1 && (flag.startsWith('-') || flag.startsWith('+'))) {
      continue; // a flag that carries no separate value — keep scanning
    }
    return undefined; // the first operand — a file, not a -c script
  }
  return undefined;
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
  for (const segment of segments(command)) {
    const toks = tokens(segment);
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
