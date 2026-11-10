/**
 * EventSource — the reconcile loop's only contract with "when to run".
 * An EventSource yields Planes snapshots; `converge()` consumes them
 * identically no matter what produced them. Swapping the source changes
 * the trigger, never the convergence (spec bro-762eh).
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { BRO } from './lib.ts';
import { diffKey, type Planes, readPlanes } from './planes.ts';

export interface EventSource extends AsyncIterable<Planes> {}

/** v1: poll. Re-reads the planes every `everyMs` and yields a snapshot
 *  when the diff-key moved — plus every FORCE_EVERYth tick regardless:
 *  a pass that half-failed (a refused `worktree open`, a dropped split)
 *  leaves the key unchanged, so without the heartbeat yield it would
 *  never be retried. A quiet rig still costs almost nothing. */
const FORCE_EVERY = 4;

export class PollSource implements EventSource {
  private readonly repo: string;
  private readonly everyMs: number;

  // no parameter properties — node runs these files with strip-only
  // type handling, where they are a syntax error
  constructor(repo: string, everyMs: number = 30_000) {
    this.repo = repo;
    this.everyMs = everyMs;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Planes, void> {
    let last = '';
    let tick = 0;
    for (;;) {
      const snap = readPlanes(this.repo);
      const key = diffKey(snap);
      tick += 1;
      if (key !== last || tick % FORCE_EVERY === 0) {
        last = key;
        yield snap;
      }
      await new Promise(r => setTimeout(r, this.everyMs));
    }
  }
}

/** Settle window after an event wake — a burst of bus frames costs one
 *  `readPlanes`, not one per frame. */
const COALESCE_MS = 300;

/** One coalesced wake flag: `poke()` resolves the armed `wait` early —
 *  or, when nothing waits, marks `pending` so the next `wait` returns
 *  immediately. An event between passes is never dropped: it latches
 *  one early wake for the next sleep. */
class Waker {
  private waiter: (() => void) | undefined;
  private wakeTimer: NodeJS.Timeout | undefined;
  private pending = false;

  poke(): void {
    const w = this.waiter;
    this.waiter = undefined;
    if (w === undefined) {
      this.pending = true;
      return;
    }
    if (this.wakeTimer !== undefined) clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
    w();
  }

  /** Resolves true on an event wake, false on timeout. */
  wait(ms: number): Promise<boolean> {
    if (this.pending) {
      this.pending = false;
      return Promise.resolve(true);
    }
    return new Promise(resolve => {
      // NOT unref'd — the sleep is the loop's heartbeat: with the broker
      // down (dead child + unref'd respawn) an unref'd sleep leaves the
      // event loop empty and node exits instead of polling
      this.wakeTimer = setTimeout(() => {
        this.waiter = undefined;
        this.wakeTimer = undefined;
        resolve(false);
      }, ms);
      this.waiter = () => resolve(true);
    });
  }

  /** Drop an armed sleep — a suspended wait must not hold the process
   *  past the iterator's end. */
  dispose(): void {
    if (this.wakeTimer !== undefined) clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
    this.waiter = undefined;
    this.pending = false;
  }
}

/** The bus feed as a managed child — `bro bus subscribe --json` streams
 *  one envelope per line until the broker closes it; a dead broker is a
 *  non-zero exit. The child is respawned with a bounded backoff so the
 *  feed self-heals when a broker appears, and the poll cadence carries
 *  the loop whenever it is absent — identical to v1 semantics. */
class BusTail {
  private readonly repo: string;
  private readonly argv: string[];
  private readonly onEvent: () => void;
  private child: ChildProcess | undefined;
  private respawn: NodeJS.Timeout | undefined;
  private backoffMs = 5_000;
  private spawnedAt = 0;
  private dead = false;

  constructor(repo: string, argv: string[], onEvent: () => void) {
    this.repo = repo;
    this.argv = argv;
    this.onEvent = onEvent;
    this.start();
  }

  /** Consume the line buffer — one event wake per complete frame. */
  private onData(buf: string, c: Buffer): string {
    let out = buf + c.toString('utf8');
    let nl = out.indexOf('\n');
    while (nl !== -1) {
      const line = out.slice(0, nl);
      out = out.slice(nl + 1);
      if (line.trim() !== '') this.onEvent();
      nl = out.indexOf('\n');
    }
    return out;
  }

  private onClose(): void {
    this.child = undefined;
    if (this.dead) return;
    // a child that lived past a full poll cycle was healthy — its
    // death deserves a prompt retry, not the accumulated backoff
    this.backoffMs =
      Date.now() - this.spawnedAt > 30_000 ? 5_000 : Math.min(this.backoffMs * 2, 300_000);
    this.respawn = setTimeout(() => this.start(), this.backoffMs);
    this.respawn.unref?.();
  }

  private start(): void {
    if (this.dead) return;
    this.spawnedAt = Date.now();
    const [bin, ...rest] = this.argv;
    if (bin === undefined) return;
    const child = spawn(bin, rest, {
      cwd: this.repo,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    this.child = child;
    let buf = '';
    child.stdout?.on('data', (c: Buffer) => {
      buf = this.onData(buf, c);
    });
    child.on('error', () => {
      // spawn failure — 'close' follows and handles the respawn
    });
    child.on('close', () => this.onClose());
  }

  kill(): void {
    this.dead = true;
    if (this.respawn !== undefined) clearTimeout(this.respawn);
    this.respawn = undefined;
    this.child?.kill('SIGTERM');
    this.child = undefined;
  }
}

/** The production tail argv — injectable for tests so a fake feed
 *  needs no real broker. */
export const BUS_TAIL_ARGV = [
  BRO,
  'bus',
  'subscribe',
  '--topic',
  'worker',
  '--topic',
  'worktree',
  '--topic',
  'gate',
  '--topic',
  'notify',
  '--json',
];

/** v2: event-woken polling — PollSource's own loop (diff-key + forced
 *  heartbeat) with the sleep made interruptible by bus events. A
 *  matching event ends the sleep early; the diff-key still decides what
 *  yields, so events change WHEN the planes are read, never WHAT a pass
 *  converges. Broker down → the tail fails to spawn/respawn and the
 *  loop degrades to PollSource verbatim (spec bro-8dbyb). */
export class LiveSource implements EventSource {
  private readonly repo: string;
  private readonly everyMs: number;
  private readonly noBus: boolean;
  private readonly busArgv: string[];
  private readonly read: (repo: string) => Planes;

  constructor(
    repo: string,
    everyMs: number = 30_000,
    opts: {
      noBus?: boolean;
      busArgv?: string[];
      /** planes reader override — tests hand a stub, never a real rig. */
      read?: (repo: string) => Planes;
    } = {}
  ) {
    this.repo = repo;
    this.everyMs = everyMs;
    this.noBus = opts.noBus === true;
    this.busArgv = opts.busArgv ?? BUS_TAIL_ARGV;
    this.read = opts.read ?? readPlanes;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Planes, void> {
    const wake = new Waker();
    const tail = this.noBus ? null : new BusTail(this.repo, this.busArgv, () => wake.poke());
    try {
      let last = '';
      let tick = 0;
      for (;;) {
        const snap = this.read(this.repo);
        const key = diffKey(snap);
        tick += 1;
        if (key !== last || tick % FORCE_EVERY === 0) {
          last = key;
          yield snap;
        }
        const woke = await wake.wait(this.everyMs);
        if (woke) await new Promise(r => setTimeout(r, COALESCE_MS));
      }
    } finally {
      tail?.kill();
      wake.dispose();
    }
  }
}
