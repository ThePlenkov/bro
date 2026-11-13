/** FakeBro — a scripted `bro` executable for e2e. The host plugin's
 *  CLI ladder resolves `bro` on PATH; installing FakeBro overwrites the
 *  fixture shim so every `bro hooks <event>` / `bro <verb>` the adapter
 *  spawns lands on this responder instead of the real CLI.
 *
 *  Two reply channels per hook event:
 *    - `hookRules` — persistent guards, first match wins, never consumed
 *      (e.g. "block tool X forever").
 *    - `hookSeq`   — FIFO scenarios, one reply per call, last repeats
 *      (e.g. stop gate: block once, then pass).
 *
 *  Every invocation is journaled to JSONL — `journal()` is the assertion
 *  surface: which events fired, with what payload, in what order.
 *
 *  Config is baked into the generated script as JSON — data only, no
 *  functions or regexes. For payload-conditional logic beyond
 *  `matchTool`, drive it from `hookSeq` ordering or extend this file. */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { E2eEnv } from '../env.ts';

/** The control object `bro hooks <event>` prints (adapter-core's
 *  HookControl, in fixture spelling). */
export interface HookReply {
  /** 'block'/'deny' vetoes tools and stops; 'approve' answers permission. */
  decision?: string;
  /** Human reason — surfaces as the reprompt text / veto error. */
  reason?: string;
  /** → hookSpecificOutput.additionalContext (session-start, prompt-submit,
   *  pre-compact, post-tool, stop hints). */
  context?: string;
  /** → hookSpecificOutput.tool_input — merged over the tool args (pre-tool). */
  toolInput?: Record<string, unknown>;
}

/** A persistent hook rule: applies while `matchTool` (payload.tool_name)
 *  is absent or equal. First matching rule in the array wins. */
export interface HookRule {
  matchTool?: string;
  reply: HookReply;
}

/** `bro <argv>` canned answer. `code` nonzero IS the answer for gate
 *  verbs — the adapter surfaces it verbatim. */
export interface FakeCommand {
  code?: number;
  stdout?: string;
  stderr?: string;
}

export interface FakeBroConfig {
  /** Per-event persistent rules: `{'pre-tool': [{matchTool:'bash', reply:{decision:'block',reason:'no bash'}}]}` */
  hookRules?: Record<string, HookRule[]>;
  /** Per-event FIFO replies: `{'stop': [{decision:'block',reason:'unfinished'},{ }]}` —
   *  call 1 blocks, call 2+ gets the last entry ({} = no opinion). */
  hookSeq?: Record<string, HookReply[]>;
  /** `bro status --json` payload — the widget/board read. */
  status?: unknown;
  /** Exact-argv or first-token canned commands: `{'act status': {...}, 'spec': {...}}`. */
  commands?: Record<string, FakeCommand>;
  /** Fallback for any unlisted `bro <verb>`. */
  defaultCommand?: FakeCommand;
}

export interface FakeBroEntry {
  kind: 'hook' | 'command';
  event?: string;
  argv: string[];
  payload?: unknown;
  cwd?: string;
  ts: number;
}

/** The generated responder — plain JS (valid TS), run by `node` via the
 *  PATH shim. CONFIG and JOURNAL are baked in; SEQ counters live for the
 *  process — each `bro` invocation is a fresh process, so sequence state
 *  must persist on disk. */
const SCRIPT = `import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
const CONFIG = __CONFIG__;
const JOURNAL = __JOURNAL__;
const COUNTERS = __COUNTERS__;
const argv = process.argv.slice(2);
const chunks = [];
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('end', () => {
  const raw = Buffer.concat(chunks).toString('utf8');
  let payload = {};
  try { payload = raw === '' ? {} : JSON.parse(raw); } catch { payload = { _raw: raw }; }
  const journal = entry => {
    try { appendFileSync(JOURNAL, JSON.stringify(entry) + '\\n'); } catch {}
  };
  if (argv[0] === 'hooks') {
    if (argv.length < 2) process.exit(0);
    const event = argv[1];
    journal({ kind: 'hook', event, argv, payload, cwd: process.cwd(), ts: Date.now() });
    const reply = resolveHook(event, payload);
    const ho = {};
    if (reply.context) ho.additionalContext = reply.context;
    if (reply.toolInput) ho.tool_input = reply.toolInput;
    const control = {};
    if (reply.decision) control.decision = reply.decision;
    if (reply.reason) control.reason = reply.reason;
    if (Object.keys(ho).length > 0) control.hookSpecificOutput = ho;
    process.stdout.write(JSON.stringify(control) + '\\n');
    process.exit(0);
  }
  journal({ kind: 'command', argv, cwd: process.cwd(), ts: Date.now() });
  if (argv[0] === 'status' && argv.includes('--json')) {
    process.stdout.write(JSON.stringify(CONFIG.status ?? {}) + '\\n');
    process.exit(0);
  }
  const key = argv.join(' ');
  const cmd = (CONFIG.commands && (CONFIG.commands[key] ?? CONFIG.commands[argv[0]]))
    ?? CONFIG.defaultCommand ?? {};
  if (cmd.stdout) process.stdout.write(cmd.stdout);
  if (cmd.stderr) process.stderr.write(cmd.stderr);
  process.exit(cmd.code ?? 0);
});
function resolveHook(event, payload) {
  const rules = CONFIG.hookRules && CONFIG.hookRules[event];
  if (rules) {
    for (const r of rules) {
      if (r.matchTool === undefined || r.matchTool === (payload && payload.tool_name)) {
        return r.reply ?? {};
      }
    }
  }
  const seq = CONFIG.hookSeq && CONFIG.hookSeq[event];
  if (seq && seq.length > 0) {
    let counts = {};
    try { counts = existsSync(COUNTERS) ? JSON.parse(readFileSync(COUNTERS, 'utf8')) : {}; } catch {}
    const i = Math.min(counts[event] ?? 0, seq.length - 1);
    counts[event] = (counts[event] ?? 0) + 1;
    try { writeFileSync(COUNTERS, JSON.stringify(counts)); } catch {}
    return seq[i] ?? {};
  }
  return {};
}
`;

export class FakeBro {
  journalPath = '';
  private countersPath = '';

  constructor(private readonly config: FakeBroConfig = {}) {}

  /** Materialize the responder and point the fixture `bro` shim at it.
   *  Call AFTER makeEnv — overwrites env.binDir/bro. */
  install(e: E2eEnv, dir?: string): this {
    const target = dir ?? join(e.root, 'fake-bro');
    mkdirSync(target, { recursive: true });
    const scriptPath = join(target, 'bro.ts');
    this.journalPath = join(target, 'journal.jsonl');
    this.countersPath = join(target, 'counters.json');
    const script = SCRIPT.replace('__CONFIG__', JSON.stringify(this.config))
      .replace('__JOURNAL__', JSON.stringify(this.journalPath))
      .replace('__COUNTERS__', JSON.stringify(this.countersPath));
    writeFileSync(scriptPath, script);
    const shim = join(e.binDir, 'bro');
    writeFileSync(shim, `#!/bin/sh\nexec node "${scriptPath}" "$@"\n`);
    chmodSync(shim, 0o755);
    return this;
  }

  /** Every `bro` invocation the fixture saw, in order. */
  journal(): FakeBroEntry[] {
    try {
      return readFileSync(this.journalPath, 'utf8')
        .split('\n')
        .filter(l => l !== '')
        .map(l => JSON.parse(l) as FakeBroEntry);
    } catch {
      return [];
    }
  }

  /** Hook journal entries only. */
  hookEvents(): string[] {
    return this.journal()
      .filter(en => en.kind === 'hook')
      .map(en => en.event ?? '');
  }
}
