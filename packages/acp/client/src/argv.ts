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
interface Word {
  text: string;
  quoted: boolean;
}

/** Split a command line into argv words — no expansion, ever. */
export function splitArgv(command: string): string[] {
  const words: Word[] = [];
  let cur = '';
  let started = false;
  let quote: '"' | "'" | undefined;
  let escaped = false;

  for (const ch of command) {
    if (escaped) {
      cur += ch;
      escaped = false;
      started = true;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      // a backslash escapes the next char — inside single quotes it
      // is literal (the shell's own rule)
      escaped = true;
      started = true;
      continue;
    }
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      else cur += ch;
      started = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        words.push({ text: cur, quoted: false });
        cur = '';
        started = false;
      }
      continue;
    }
    cur += ch;
    started = true;
  }
  if (quote !== undefined) throw new Error('unclosed quote');
  if (escaped) cur += '\\';
  if (started) words.push({ text: cur, quoted: false });
  return words.map(w => w.text);
}

/**
 * The words, plus whether any of them came from a quoted span — a
 * quoted word is DATA, an unquoted one is also data, but a caller
 * that cares about the difference (an operator's own quoting) can
 * ask.
 */
export function splitArgvDetailed(command: string): { text: string; quoted: boolean }[] {
  const out: { text: string; quoted: boolean }[] = [];
  let cur = '';
  let started = false;
  let quoted = false;
  let quote: '"' | "'" | undefined;
  let escaped = false;
  const push = (): void => {
    if (!started) return;
    out.push({ text: cur, quoted });
    cur = '';
    started = false;
    quoted = false;
  };
  for (const ch of command) {
    if (escaped) {
      cur += ch;
      escaped = false;
      started = true;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      else cur += ch;
      started = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      quoted = true;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    cur += ch;
    started = true;
  }
  if (quote !== undefined) throw new Error('unclosed quote');
  if (escaped) cur += '\\';
  push();
  return out;
}
