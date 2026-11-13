/** ScriptedCli — the generic "mock a CLI dependency" layer. Where FakeBro
 *  speaks bro's hook protocol, ScriptedCli answers arbitrary `argv` for
 *  any binary the fixture PATH can shadow: `bd`, `gh`, `glab`, `dolt`,
 *  `jira`, … Each invocation is journaled; rules match on an argv
 *  substring, first hit wins, `default` catches the rest.
 *
 *  Same constraint as FakeBro: config is baked JSON — data only. For
 *  logic beyond substring matching, match on a distinctive argv token
 *  (`bd ready --json` vs `bd show`) or extend the rule shape. */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { E2eEnv } from '../env.ts';

export interface ShimReply {
  code?: number;
  stdout?: string;
  stderr?: string;
}

export interface ShimRule extends ShimReply {
  /** Substring matched against `argv.join(' ')` — e.g. 'ready --json'. */
  match: string;
}

export interface ScriptedCliConfig {
  rules?: ShimRule[];
  /** Fallback for unmatched argv. */
  fallback?: ShimReply;
}

export interface ShimEntry {
  bin: string;
  argv: string[];
  cwd?: string;
  ts: number;
}

const SCRIPT = `import { appendFileSync } from 'node:fs';
const CONFIG = __CONFIG__;
const JOURNAL = __JOURNAL__;
const BIN = __BIN__;
const argv = process.argv.slice(2);
try { appendFileSync(JOURNAL, JSON.stringify({ bin: BIN, argv, cwd: process.cwd(), ts: Date.now() }) + '\\n'); } catch {}
const hay = argv.join(' ');
const rule = (CONFIG.rules || []).find(r => hay.includes(r.match));
const reply = rule || CONFIG.fallback || {};
if (reply.stdout) process.stdout.write(reply.stdout);
if (reply.stderr) process.stderr.write(reply.stderr);
process.exit(reply.code ?? 0);
`;

export class ScriptedCli {
  journalPath = '';
  private readonly bin: string;

  constructor(
    bin: string,
    private readonly config: ScriptedCliConfig = {}
  ) {
    this.bin = bin;
  }

  /** Materialize the responder and shadow `bin` on the fixture PATH.
   *  Call AFTER makeEnv — writes env.binDir/<bin>. */
  install(e: E2eEnv, dir?: string): this {
    const target = dir ?? join(e.root, `shim-${this.bin}`);
    mkdirSync(target, { recursive: true });
    const scriptPath = join(target, `${this.bin}.ts`);
    this.journalPath = join(target, 'journal.jsonl');
    const script = SCRIPT.replace('__CONFIG__', JSON.stringify(this.config))
      .replace('__JOURNAL__', JSON.stringify(this.journalPath))
      .replace('__BIN__', JSON.stringify(this.bin));
    writeFileSync(scriptPath, script);
    const shim = join(e.binDir, this.bin);
    writeFileSync(shim, `#!/bin/sh\nexec node "${scriptPath}" "$@"\n`);
    chmodSync(shim, 0o755);
    return this;
  }

  journal(): ShimEntry[] {
    try {
      return readFileSync(this.journalPath, 'utf8')
        .split('\n')
        .filter(l => l !== '')
        .map(l => JSON.parse(l) as ShimEntry);
    } catch {
      return [];
    }
  }
}
