/**
 * Step 0 experiment (bead bro-l8wqu): does `opencode acp` stream live
 * session/update notifications CROSS-PROCESS to a second client that
 * attaches via session/load while the owner keeps working?
 *
 * Process A: initialize → session/new → session/prompt (slow task).
 * Process B (spawned ~3s into A's turn): initialize → session/load A's
 * sessionId → collect updates for ~25s.
 *
 * Verdict rule: updates that arrive on B with an event-time AFTER B's
 * load resolved are live cross-process streams; updates that only land
 * during/before the load response are replay.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Rpc {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

const stamps: { who: string; t: number; what: string }[] = [];
const t0 = Date.now();
const mark = (who: string, what: string): void => {
  stamps.push({ who, t: Date.now() - t0, what });
  console.log(`[${String(Date.now() - t0).padStart(6)}ms] ${who}: ${what}`);
};

class Client {
  readonly name: string;
  private child: ChildProcess;
  private nextId = 0;
  private pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
  onUpdate?: (u: unknown) => void;

  constructor(name: string, cwd: string) {
    this.name = name;
    this.child = spawn('opencode', ['acp'], {
      cwd,
      env: { ...process.env, BRO_HOOKS: '0' },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    createInterface({ input: this.child.stdout! }).on('line', l => {
      const t = l.trim();
      if (t === '') return;
      let m: Rpc;
      try {
        m = JSON.parse(t) as Rpc;
      } catch {
        mark(this.name, `unparseable: ${t.slice(0, 80)}`);
        return;
      }
      if (m.method === 'session/update') {
        this.onUpdate?.((m.params as { update?: unknown })?.update);
        return;
      }
      if (m.id !== null && m.id !== undefined && m.method === undefined) {
        const slot = this.pending.get(m.id as number);
        if (slot !== undefined) {
          this.pending.delete(m.id as number);
          if (m.error !== undefined) slot.rej(new Error(`${m.error.code}: ${m.error.message}`));
          else slot.res(m.result);
        }
        return;
      }
      if (m.method !== undefined && m.id !== null && m.id !== undefined) {
        // inbound request (permission/fs) — deny politely
        this.send({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'cancelled' } } });
      }
    });
    this.child.once('exit', c => mark(this.name, `CHILD EXIT code=${c}`));
  }

  private send(m: Rpc): void {
    this.child.stdin!.write(`${JSON.stringify(m)}\n`);
  }

  async request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.nextId;
    const p = new Promise<unknown>((res, rej) => this.pending.set(id, { res, rej }));
    this.send({ jsonrpc: '2.0', id, method, params });
    return p;
  }

  kill(): void {
    this.child.kill('SIGKILL');
  }
}

const cwd = mkdtempSync(join(tmpdir(), 'acp-xproc-'));
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

const A = new Client('A', cwd);
const initA = (await A.request('initialize', {
  protocolVersion: 1,
  clientInfo: { name: 'xproc-a', version: '0' },
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
})) as { protocolVersion?: number; agentCapabilities?: { loadSession?: boolean } };
mark(
  'A',
  `initialize → protocol ${initA.protocolVersion}, loadSession=${initA.agentCapabilities?.loadSession}`
);

const s = (await A.request('session/new', { cwd, mcpServers: [] })) as { sessionId?: string };
const sessionId = s.sessionId!;
mark('A', `session/new → ${sessionId}`);

let aLive = 0;
A.onUpdate = u => {
  aLive++;
  const kind = (u as { sessionUpdate?: string })?.sessionUpdate ?? '?';
  if (aLive <= 5 || aLive % 20 === 0) mark('A', `update #${aLive} ${kind}`);
};

// fire the slow prompt — do NOT await; B attaches mid-turn
const slowPrompt =
  'Tell a short story about a robot, one sentence at a time. After each ' +
  'sentence, call the "think" tool (or pause) before the next. Take your ' +
  'time — at least 8 sentences, then a one-line moral.';
const promptP = A.request('session/prompt', {
  sessionId,
  prompt: [{ type: 'text', text: slowPrompt }],
})
  .then(r => mark('A', `prompt resolved: ${JSON.stringify(r)}`))
  .catch(e => mark('A', `prompt FAILED: ${e.message}`));

await sleep(3000); // let A get going

const B = new Client('B', cwd);
const initB = (await B.request('initialize', {
  protocolVersion: 1,
  clientInfo: { name: 'xproc-b', version: '0' },
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
})) as { protocolVersion?: number; agentCapabilities?: { loadSession?: boolean } };
mark(
  'B',
  `initialize → protocol ${initB.protocolVersion}, loadSession=${initB.agentCapabilities?.loadSession}`
);

let loadDoneAt = 0;
let duringLoad = 0;
let afterLoad = 0;
B.onUpdate = u => {
  const kind = (u as { sessionUpdate?: string })?.sessionUpdate ?? '?';
  if (loadDoneAt === 0) {
    duringLoad++;
    if (duringLoad <= 5 || duringLoad % 20 === 0)
      mark('B', `update during-load #${duringLoad} ${kind}`);
  } else {
    afterLoad++;
    mark('B', `>>> LIVE update #${afterLoad} ${kind} <<<`);
  }
};

mark('B', `session/load ${sessionId} …`);
const loadRes = await B.request('session/load', { sessionId, cwd, mcpServers: [] }).catch(e => ({
  error: e.message,
}));
loadDoneAt = Date.now() - t0;
mark(
  'B',
  `session/load resolved: ${JSON.stringify(loadRes).slice(0, 200)} — ${duringLoad} updates replayed during load`
);

// watch for live cross-process updates while A still works
await sleep(25_000);
const aUpdatesAtEnd = aLive;
mark(
  'EXPERIMENT',
  `A produced ${aUpdatesAtEnd} updates total; B saw ${duringLoad} during load + ${afterLoad} after load`
);

// let A's prompt settle (or note it's still running)
await Promise.race([promptP, sleep(20_000)]);
mark(
  'EXPERIMENT',
  `verdict input: afterLoad=${afterLoad} ${afterLoad > 0 ? '→ LIVE CROSS-PROCESS STREAMING' : '→ REPLAY SNAPSHOT ONLY'}`
);

A.kill();
B.kill();
process.exit(0);
