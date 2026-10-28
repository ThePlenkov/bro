/**
 * Published-surface helpers — resolve what `npm i -g @broject/bro`
 * actually dispatches. Shared by `gen-published.ts` (writes the
 * contract/published.json snapshot) and `check-onboarding.ts` (the
 * docs↔release gate — spec bro-l8c4f.17).
 *
 * Never *executes* documented commands: several published commands
 * (`bro watch`, `bro sync`, `bro doctor`, `bro fleet`) treat `--help`
 * as "run it" and have real side effects. Everything here is
 * dispatch-level parsing of help output — the only invocations are
 * `bro --help`, `bro --version`, and `bro <name> --help` inside a
 * non-git scratch dir at snapshot-generation time.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(fileURLToPath(import.meta.url), '..', '..');
export const PUBLISHED_PATH = join(root, 'contract', 'published.json');

export interface PublishedSurface {
  package: string;
  spec: string;
  version: string;
  /** announced next release — the version boundary unreleased commands land in */
  next: string;
  generatedAt: string;
  /** command name → recorded subcommand words (flags may slip in — advisory) */
  commands: Record<string, string[]>;
  docNouns: string[];
  docVerbs: string[];
}

export const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** `-flag value` lookup for the two registry-facing scripts. */
export function argFlag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

/** A `bro <name>` registry row — the usage anchors' command word plus
 *  its summary signature. */
export interface CommandRef {
  name: string;
  summary: string;
}

/** `npm view <spec> version` — resolved semver for a dist-tag or range. */
function resolvedVersion(spec: NpmSpec): string {
  const out = execFileSync(NPM, ['view', spec.value, 'version'], { encoding: 'utf8' }).trim();
  // a range spec prints one line per match — the last is the highest
  const lines = out.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /(\d+\.\d+\.\d+(?:[-+][\w.-]*)?)/.exec(lines[i]!);
    if (m) {
      return m[1]!;
    }
  }
  throw new Error(`npm view ${spec} version: unparseable output`);
}

/** The npm package spec under probe — `@broject/bro@latest`, a pinned
 *  `name@version`, or a range. One value carried through resolve →
 *  pin → install so a floating dist-tag cannot drift mid-probe. */
export class NpmSpec {
  private resolved?: string;
  readonly value: string;

  private constructor(value: string) {
    this.value = value;
  }

  /** The npm spec to probe: `--spec`, then `BRO_PUBLISHED_SPEC`, then latest. */
  static resolve(argv: readonly string[]): NpmSpec {
    return new NpmSpec(
      argFlag(argv, '--spec') ?? process.env.BRO_PUBLISHED_SPEC ?? '@broject/bro@latest'
    );
  }

  /** `@broject/bro` — the package half of the spec. */
  get package(): string {
    const at = this.value.lastIndexOf('@');
    return at > 0 ? this.value.slice(0, at) : this.value;
  }

  /** `latest` — the dist-tag or version half of the spec. */
  get tag(): string {
    const at = this.value.lastIndexOf('@');
    return at > 0 ? this.value.slice(at + 1) : 'latest';
  }

  /** `npm view <spec> version` — the resolved semver. Memoized: a
   *  floating tag could move between the version probe and the
   *  install, recording one version's help under another. */
  get version(): string {
    return (this.resolved ??= resolvedVersion(this));
  }

  /** `pkg@<resolved-version>` — the install pins what `version`
   *  resolved. */
  pinned(): NpmSpec {
    return new NpmSpec(`${this.package}@${this.version}`);
  }

  /** `npm i -g --prefix <tmp> <spec>` — the clean install users run. */
  install(): Install {
    const dir = mkdtempSync(join(tmpdir(), 'bro-published-'));
    const prefix = join(dir, 'prefix');
    execFileSync(NPM, ['install', '-g', '--prefix', prefix, this.value], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const bin = join(prefix, 'bin', 'bro');
    if (!existsSync(bin)) {
      throw new Error(`${this.value}: no bin/bro under ${prefix}`);
    }
    return new Install({ bin, dir });
  }

  /** Resolve, pin, install, and probe `bro --help` — the shared
   *  fixture for `gen-published.ts` and `check-onboarding.ts`. */
  probe(): Probe {
    const install = this.pinned().install();
    const top = parseTopLevelHelp(install.run(['--help']));
    return { install, top, version: this.version };
  }

  toString(): string {
    return this.value;
  }
}

/** The probed published fixture — the install, its parsed top-level
 *  help, and the resolved version, shared by the snapshot writer and
 *  the onboarding gate. */
export interface Probe {
  install: Install;
  top: TopHelp;
  version: string;
}

/** Paths inside the `--prefix` install fixture. */
export interface InstallPaths {
  bin: string;
  dir: string;
}

/** The `--prefix` install fixture — the bin plus a non-git scratch
 *  cwd: several published commands run on `--help`, and a repo cwd
 *  would hand them a store. */
export class Install {
  readonly bin: string;
  readonly dir: string;
  readonly scratch: string;

  constructor(paths: InstallPaths) {
    this.bin = paths.bin;
    this.dir = paths.dir;
    this.scratch = mkdtempSync(join(this.dir, 'scratch-'));
  }

  /** Run the installed bin, capturing both streams — spawnSync never
   *  throws on a non-zero exit, which is the point: dispatched-but-
   *  failing commands still print their usage. */
  run(args: readonly string[]): string {
    const r = spawnSync(this.bin, [...args], {
      cwd: this.scratch,
      encoding: 'utf8',
      timeout: 30000,
    });
    // a failed spawn or a timeout kill returns near-empty output that
    // downstream parsers would silently read as "no such surface" — a
    // dead probe must fail loudly. A plain non-zero exit is fine:
    // dispatched-but-failing commands still print usage to stderr.
    if (r.error !== undefined || r.signal !== null) {
      throw new Error(
        `${this.bin} ${args.join(' ')}: ${r.error?.message ?? `killed by ${r.signal}`}`
      );
    }
    return `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  }

  /** `bro <name> --help` captured as a scannable doc. */
  helpFor(command: CommandRef): HelpDoc {
    return new HelpDoc({
      name: command.name,
      summary: command.summary,
      out: this.run([command.name, '--help']),
    });
  }
}

export interface TopHelp {
  /** name → summary line */
  commands: Map<string, string>;
  docNouns: string[];
  docVerbs: string[];
}

/** `bro --help` → the Commands: rows plus `doc types:`/`shorthand:`
 *  lines. Indentation-based: rows are `  name   summary`, the block
 *  ends at a blank line. */
function parseTopLevelHelp(out: string): TopHelp {
  const commands = new Map<string, string>();
  const docNouns: string[] = [];
  const docVerbs: string[] = [];
  let inCmds = false;
  for (const line of out.split('\n')) {
    if (/^\s*Commands:\s*$/.test(line)) {
      inCmds = true;
      continue;
    }
    if (!inCmds) {
      continue;
    }
    const dt = /^\s*doc types:\s+([^—]+)/.exec(line);
    if (dt) {
      docNouns.push(...dt[1]!.trim().split(/\s+/));
      continue;
    }
    const sh = /^\s*shorthand:\s+([^—]+)/.exec(line);
    if (sh) {
      docVerbs.push(...sh[1]!.trim().split(/\s+/));
      continue;
    }
    const row = /^\s{2}([a-z][\w-]*)\s{2,}(\S.*)$/.exec(line);
    if (row) {
      commands.set(row[1]!, row[2]!);
      continue;
    }
    if (line.trim() === '') {
      inCmds = false;
    }
  }
  return { commands, docNouns, docVerbs };
}

/** `a|b|c` alternation — the signature shape summaries embed
 *  (`status|up|down`). Scoped to the summary line: inside help bodies
 *  the same shape is flag values (`--by author|source|area`), not subs. */
const ALT_SIG = /[a-z][a-z0-9-]*(?:\|[a-z0-9][a-z0-9-]*)+/;

/** Usage grammar tokens that are not subcommands. */
const STOPWORDS = new Set(['command', 'commands', 'subcommand', 'args', 'arg']);

/** Slot shapes anchored right after the command name — literal
 *  patterns, applied to the text following each `bro <name>` hit. */
const ANGLED_SLOT = /^\s+<([a-z0-9][a-z0-9|-]*)>/;
const SPACED_SLOT = /^\s+((?:[a-z][\w-]*\s*\|\s*)+[a-z][\w-]*)/;
const WORD_SLOT = /^\s+([a-z][a-z0-9-]*)\b/;

/** Candidate subcommand words: `subs` is every word an extraction
 *  shape saw; `confirmed` is the subset an anchored usage source
 *  (`bro <n> <sub>` slot or a Commands: row) named outright. */
class Subs {
  readonly subs = new Set<string>();
  readonly confirmed = new Set<string>();

  add(word: string, sure: boolean): void {
    if (word === '' || STOPWORDS.has(word)) {
      return;
    }
    this.subs.add(word);
    if (sure) {
      this.confirmed.add(word);
    }
  }

  addAlt(alt: string, sure: boolean): void {
    for (const s of alt.split('|')) {
      this.add(s.trim(), sure);
    }
  }
}

/** A `name` hit in the doc — a candidate `bro <name>` usage anchor. */
interface Hit {
  at: number;
}

/** One `bro <name>` usage occurrence — `line` is the matched line's
 *  remainder; `tail` the remainder of the whole help text (a slot
 *  alternation may wrap to the next line). */
interface Usage {
  line: string;
  tail: string;
}

/** A `bro <name> --help` capture plus the command's registry summary —
 *  the document every subcommand-extraction shape scans. */
export class HelpDoc {
  private readonly name: string;
  private readonly summary: string;
  private readonly out: string;

  constructor(fields: CommandRef & { out: string }) {
    this.name = fields.name;
    this.summary = fields.summary;
    this.out = fields.out;
  }

  /** Subcommand words for the command, from its summary signature and
   *  its own help output. Only four shapes count — all anchored, so
   *  flag-value alternations and `<id|step>` placeholders stay out:
   *  the registry summary's `a|b` signature, `<a|b|c>` or `a | b`
   *  alternations directly in the subcommand slot, `bro <name> <sub>`
   *  words, and `Commands:` block first tokens. Advisory by design —
   *  consumers treat absence as "unverified", not "absent". */
  subs(): string[] {
    const acc = new Subs();
    const sig = ALT_SIG.exec(this.summary);
    if (sig !== null) {
      acc.addAlt(sig[0], false);
    }
    for (const usage of this.usages()) {
      this.collectSlots(acc, usage);
      this.collectFollowers(acc, usage);
    }
    this.collectBlock(acc);
    this.dropFlagLeaks(acc);
    return [...acc.subs].sort((a, b) => a.localeCompare(b));
  }

  /** Every `bro <name>` usage occurrence — `bro` plus whitespace plus a
   *  word-bounded name. The command name is dynamic, so the anchor is
   *  indexOf + boundary checks, not `new RegExp(name)`. */
  private usages(): Usage[] {
    const hits: Usage[] = [];
    for (
      let at = this.out.indexOf(this.name);
      at !== -1;
      at = this.out.indexOf(this.name, at + 1)
    ) {
      if (!this.anchored({ at })) {
        continue;
      }
      const end = at + this.name.length;
      const nl = this.out.indexOf('\n', end);
      hits.push({
        line: this.out.slice(end, nl === -1 ? undefined : nl),
        tail: this.out.slice(end),
      });
    }
    return hits;
  }

  /** The hit is a `bro <name>` anchor: whitespace before it, a
   *  word-bounded `bro` before that, and a word boundary after `name`. */
  private anchored(hit: Hit): boolean {
    if (hit.at === 0) {
      return false;
    }
    if (!/\s/.test(this.out[hit.at - 1]!)) {
      return false;
    }
    if (!this.broBefore(hit)) {
      return false;
    }
    const end = hit.at + this.name.length;
    return !/\w/.test(this.out[end] ?? '');
  }

  /** A word-bounded `bro` ends the non-whitespace run right before
   *  the hit's leading whitespace. */
  private broBefore(hit: Hit): boolean {
    const s = this.wordStart(hit);
    if (s < 3) {
      return false;
    }
    if (this.out.slice(s - 3, s) !== 'bro') {
      return false;
    }
    return !/\w/.test(this.out[s - 4] ?? '');
  }

  /** Start of the non-whitespace run ending at the hit. */
  private wordStart(hit: Hit): number {
    let s = hit.at - 1;
    while (s > 0 && /\s/.test(this.out[s - 1]!)) {
      s--;
    }
    return s;
  }

  /** Anchored usage slots: `bro <name> <a|b>`, `bro <name> a | b`,
   *  and `bro <name> <word>` — every hit confirms the subcommand. */
  private collectSlots(acc: Subs, usage: Usage): void {
    const angled = ANGLED_SLOT.exec(usage.tail);
    if (angled !== null) {
      acc.addAlt(angled[1]!, true);
    }
    const spaced = SPACED_SLOT.exec(usage.tail);
    if (spaced !== null) {
      acc.addAlt(spaced[1]!, true);
    }
    const word = WORD_SLOT.exec(usage.tail);
    if (word !== null) {
      acc.add(word[1]!, true);
    }
  }

  /** ` | sub` followers inside one `bro <name>` line — `status |
   *  distill | run`. `(?!-)` keeps flag alternations (`--json|--live`)
   *  out, and the `<`-balance keeps `<id|step>` placeholders out. Not an
   *  anchored slot on its own — followers stay unconfirmed. */
  private collectFollowers(acc: Subs, usage: Usage): void {
    for (const m of usage.line.matchAll(/\|\s*(?!-)([a-z][\w-]*)/g)) {
      const before = usage.line.slice(0, m.index);
      if (before.split('<').length <= before.split('>').length) {
        acc.add(m[1]!, false);
      }
    }
  }

  /** The `Commands:` block of a command's own help — each row's first
   *  token is a confirmed subcommand. Same indentation walk as
   *  parseTopLevelHelp, at one level down. */
  private collectBlock(acc: Subs): void {
    let inCmds = false;
    for (const line of this.out.split('\n')) {
      if (/^\s*Commands:\s*$/.test(line)) {
        inCmds = true;
        continue;
      }
      if (!inCmds) {
        continue;
      }
      const m = /^\s{2}([a-z][\w-]*)\s/.exec(line);
      if (m !== null) {
        acc.add(m[1]!, true);
        continue;
      }
      if (line.trim() === '') {
        inCmds = false;
      }
    }
  }

  /** Unconfirmed words that also appear as `--word` (`--json` inside
   *  `install|uninstall|--json` alternations) are flag-name leaks, not
   *  subcommands. */
  private dropFlagLeaks(acc: Subs): void {
    const flags = this.flagWords();
    for (const w of acc.subs) {
      if (acc.confirmed.has(w)) {
        continue;
      }
      if (flags.has(w)) {
        acc.subs.delete(w);
      }
    }
  }

  /** Every `--word` across the summary and the help body. */
  private flagWords(): Set<string> {
    const flags = new Set<string>();
    for (const m of `${this.summary}\n${this.out}`.matchAll(/--([a-z][\w-]*)/g)) {
      flags.add(m[1]!);
    }
    return flags;
  }
}

/** `<word>` followed by a non-word char — the boundary a `\b` pattern
 *  asserts, without a dynamic `RegExp` constructor (non-literal patterns
 *  read as user-controlled regex builds to static analysis). */
export function hasFlagWord(text: string, word: string): boolean {
  for (let i = text.indexOf(word); i !== -1; i = text.indexOf(word, i + 1)) {
    const after = text[i + word.length];
    if (after === undefined || !/\w/.test(after)) {
      return true;
    }
  }
  return false;
}

export interface DocLine {
  file: string;
  line: number;
  /** argv after `bro` / `npx [-y] @broject/bro` */
  argv: string[];
  raw: string;
}

/** Every copy/paste `bro …` line inside fenced code blocks. `npm i -g`
 *  lines are skipped — the fixture install IS that step; `npx … bro`
 *  normalizes to `bro` argv. */
export function extractDocLines(file: string): DocLine[] {
  const out: DocLine[] = [];
  let inFence = false;
  const lines = readFileSync(file, 'utf8').split('\n');
  for (const [i, line] of lines.entries()) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) {
      continue;
    }
    const m = /^\s*(?:npx(?:\s+-y)?\s+@broject\/bro|bro)\s*(.*)$/.exec(line);
    if (!m) {
      continue;
    }
    const rest = m[1]!.replace(/\s+#.*$/, '').trim();
    out.push({ file, line: i + 1, argv: rest === '' ? [] : rest.split(/\s+/), raw: line.trim() });
  }
  return out;
}

export function loadPublishedSurface(): PublishedSurface | undefined {
  if (!existsSync(PUBLISHED_PATH)) {
    return undefined;
  }
  return JSON.parse(readFileSync(PUBLISHED_PATH, 'utf8')) as PublishedSurface;
}
