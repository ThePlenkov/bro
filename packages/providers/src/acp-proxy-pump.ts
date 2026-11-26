import type { AnyMessage, JsonRpcId, Stream } from '@agentclientprotocol/sdk';
import type { Outbound } from './acp-proxy-outbound.ts';
import {
  ACP_PROXY_READ_HIGH_WATER,
  errText,
  wire,
  type AcpProxyPermissionVerdict,
  type ProxySession,
} from './acp-proxy-types.ts';
type WireRead = ReadableStreamReadResult<AnyMessage>;

export type PumpOpts = {
  stream: Stream;
  route: (m: AnyMessage) => void;
  tag: string;
  out: Outbound;
  ctrl: (m: AnyMessage) => boolean;
  held: AnyMessage[];
  precede?: (heldMsg: AnyMessage, ctrl: AnyMessage) => boolean;
  isDone: () => boolean;
  done: Promise<void>;
  log: (line: string) => void;
};

export interface PromptInjectionParams {
  message: AnyMessage;
  params: Record<string, unknown>;
  sessionId: string;
  session: ProxySession;
}

export interface PermissionSettlementParams {
  message: AnyMessage;
  id: JsonRpcId;
  session: ProxySession;
  sessionId: string;
  outcome: AcpProxyPermissionVerdict | undefined;
}

type PumpIntakeState = 'saturated' | 'empty' | 'held';

/** A pre-done read — where a wait still needs a promise while the
 *  intake is paused or spent, this resolves immediately so the
 *  loop falls through to its own break conditions. */
const PUMP_READ_DONE = Promise.resolve<WireRead>({
  value: undefined,
  done: true,
});

/** Execute one pump's bounded intake state machine. Keeping the machine
 *  a class makes the orchestration seam explicit and keeps each intake
 *  state independently testable by inspection: saturated waits for room,
 *  empty reads directly, and held races room against more input. */
class PumpMachine {
  private readonly reader: ReadableStreamDefaultReader<AnyMessage>;
  private readonly wakes = new Set<() => void>();
  private read: Promise<WireRead> | undefined;
  private eof = false;
  /** Intake paused at the read bound with NO read outstanding — the
   *  prefetched one already landed in the hold. Distinct from EOF:
   *  the loop still owes the room wait, just no second read. */
  private intakePaused = false;
  /** Controls routed past a FULL ledger — accepted in-flight work
   *  neither `held` nor the ledger's own hold count sees. Enough of
   *  them pause the read side exactly like a saturated hold: a
   *  cancel or response flood meets the wire's bound instead of
   *  writing past it without limit (local cancellation never blocks
   *  — every consumed control still settles the instant it routes;
   *  the bound gates only consuming MORE). The charge decays on the
   *  leg's NEXT write settle, not on room(): bypassed work is
   *  ordinary depth once issued, and holds can keep the ledger
   *  "full" while the wire drains fine — counting until room would
   *  park the read behind work the charge no longer represents
   *  (the exact deadlock this bound exists to prevent). */
  private bypassed = 0;
  /** ONE outstanding room() subscription at a time — the parked wait
   *  re-arms on every intake result, and a waiter that loses the
   *  race stays registered until the next release, so re-arming per
   *  read grew the ledger's waiter set alongside the hold it exists
   *  to bound. A pending room promise is reused across iterations;
   *  its own settle clears the slot so a stale resolution can never
   *  fake room later. */
  private roomWait: Promise<'room'> | undefined;

  constructor(private readonly opts: PumpOpts) {
    this.reader = opts.stream.readable.getReader();
    this.read = this.reader.read();
    void opts.done.then(() => {
      for (const w of this.wakes) w();
      this.wakes.clear();
    });
  }

  /** `p`, or early resolve on shutdown — `undefined` marks the wake. */
  private untilStop<T>(p: Promise<T>): Promise<T | undefined> {
    // a wait may end early — a rejection on the abandoned branch
    // must still count as handled
    void p.catch(() => {});
    if (this.opts.isDone()) {
      return Promise.resolve(undefined);
    }
    return new Promise<T | undefined>(resolve => {
      const wake = (): void => {
        resolve(undefined);
      };
      this.wakes.add(wake);
      void p.then(
        v => {
          this.wakes.delete(wake);
          resolve(v);
        },
        () => {
          this.wakes.delete(wake);
          resolve(undefined);
        }
      );
    });
  }

  private deliver(m: AnyMessage): void {
    try {
      this.opts.route(m);
    } catch (e) {
      this.opts.log(
        `acp proxy: dropped ${this.opts.tag} ${wire(m).method ?? 'message'}: ${errText(e)}`
      );
    }
  }

  /** FIFO one-shot — the oldest outstanding charge ends on each
   *  settle; a bypass whose route wrote nothing decays on whatever
   *  lands next, which errs toward holding the bound, never
   *  toward unbounded intake. */
  private bypass(): void {
    this.bypassed++;
    void this.opts.out.nextSettle().then(() => {
      this.bypassed = Math.max(0, this.bypassed - 1);
    });
  }

  private roomReady(): Promise<'room'> {
    this.roomWait ??= this.opts.out.room().then(() => {
      this.roomWait = undefined;
      return 'room' as const;
    });
    return this.roomWait;
  }

  /** Route one consumed message — data intake joins the hold; a
   *  control message routes NOW: it only ever stops or finishes
   *  work the wire already accepted, so parking it behind the gate
   *  could deadlock the release it carries. The hold drains ahead
   *  of it only as far as the ledger's own gate allows — flushing
   *  the whole hold on every control is the amplifier that let a
   *  data/cancel alternation outrun the bound. Past the gate the
   *  control overtakes the queue, and the route-side sweeps settle
   *  its targets out of the hold it jumped. */
  private accept(m: AnyMessage): void {
    const { ctrl, held, out, precede } = this.opts;
    if (!ctrl(m)) {
      held.push(m);
      return;
    }
    while (held.length > 0 && out.spare()) {
      this.deliver(held.shift() as AnyMessage);
    }
    if (out.spare()) {
      this.bypassed = 0;
      this.deliver(m);
      return;
    }
    // routed past a saturated ledger — first pull whatever ordering
    // owes ahead of this control: a response must not overtake held
    // messages of the session it ends. The pulled writes ISSUE
    // first — still a bypass, never awaited — so the control's
    // liveness is untouched and only the wire order is repaired
    if (precede !== undefined) {
      let keep = 0;
      for (let i = 0; i < held.length; i++) {
        const h = held.at(i);
        if (h === undefined) continue;
        if (precede(h, m)) {
          this.bypass();
          this.deliver(h);
        } else {
          held[keep++] = h;
        }
      }
      held.length = keep;
    }
    // routed past a saturated ledger — count it: the hold and the
    // bypass together are the intake in flight, and their sum is
    // the read-side bound below
    this.bypass();
    this.deliver(m);
  }

  /** Handle a saturated intake, returning whether the loop should continue. */
  private async waitForIntakeRoom(): Promise<boolean> {
    const r: 'room' | { readonly read: WireRead } | undefined =
      this.read === undefined
        ? await this.untilStop(this.roomReady())
        : await this.untilStop(
            Promise.race([this.roomReady(), this.read.then(v => ({ read: v }) as const)])
          );
    if (r === undefined) return false;
    if (r === 'room') {
      this.bypassed = 0;
      this.intakePaused = false;
      this.read ??= this.reader.read();
      return true;
    }
    this.read = undefined;
    this.intakePaused = true;
    if (r.read.done) this.eof = true;
    else this.accept(r.read.value);
    return true;
  }

  /** Read directly when there is no held work to drain. */
  private async readWithoutHeld(): Promise<boolean> {
    const r: WireRead | undefined = await this.untilStop(
      this.read ?? PUMP_READ_DONE
    );
    if (r === undefined) return false;
    this.read = r.done ? undefined : this.reader.read();
    if (r.done) this.eof = true;
    else this.accept(r.value);
    return true;
  }

  /** Race room, more input, and shutdown while draining held work. */
  private async readWithHeld(): Promise<boolean> {
    const r = await this.untilStop(
      Promise.race([
        this.roomReady(),
        (this.read ?? PUMP_READ_DONE).then(v => ({ read: v }) as const),
      ])
    );
    if (r === undefined) return false;
    if (r === 'room') return true;
    this.read = r.read.done ? undefined : this.reader.read();
    if (r.read.done) this.eof = true;
    else this.accept(r.read.value);
    return true;
  }

  private stateFor(): PumpIntakeState | 'done' {
    if (this.opts.isDone() || this.eof || (this.read === undefined && !this.intakePaused)) {
      return 'done';
    }
    if (this.opts.held.length + this.bypassed >= ACP_PROXY_READ_HIGH_WATER) {
      return 'saturated';
    }
    return this.opts.held.length === 0 ? 'empty' : 'held';
  }

  /** Run the intake loop to shutdown/EOF, flush the hold, peek at an
   *  already-resolved read, then release the reader on a dead leg. */
  async run(): Promise<void> {
    const handlers: Record<PumpIntakeState, () => Promise<boolean>> = {
      saturated: () => this.waitForIntakeRoom(),
      empty: () => this.readWithoutHeld(),
      held: () => this.readWithHeld(),
    };
    const { held, out } = this.opts;
    for (;;) {
      while (held.length > 0 && out.spare()) this.deliver(held.shift() as AnyMessage);
      const state = this.stateFor();
      if (state === 'done') break;
      const handler = Object.getOwnPropertyDescriptor(handlers, state)?.value;
      if (handler === undefined || !(await handler())) break;
    }
    // flush the hold — a message the pump accepted is never dropped
    // unrouted: registered now, its pending entry exists before the
    // teardown sweep reads the table it answers from
    while (held.length > 0) {
      this.deliver(held.shift() as AnyMessage);
    }
    // a read issued before the pause may already have RESOLVED — its
    // message left the transport (the peer's write completed) yet
    // never routed: skipping it would strand an accepted request
    // outside the table the teardown sweep answers. The race is a
    // peek, not a wait — an already-settled read's race subscription
    // was queued first so it wins; a still-pending read accepted
    // nothing and loses nothing
    if (this.read !== undefined) {
      const r = await Promise.race([this.read, Promise.resolve(undefined)]).catch(() => undefined);
      if (r !== undefined) {
        if (r.done) {
          this.eof = true;
        } else {
          this.deliver(r.value);
        }
      }
    }
    // a leg ended by shutdown — never by its own EOF — cancels its
    // reader so the peer's queued writes learn the wire is gone
    // instead of parking on the stall. The release starts with the
    // call; the sweep's wait only needs the drain above, so the
    // settle never needs an await here
    if (!this.eof) {
      void this.reader.cancel().catch(() => {});
    }
  }
}

export const runPump = (opts: PumpOpts): Promise<void> => new PumpMachine(opts).run();

/**
 * The message pump — runs until either leg closes. Returns the process
 * exit code: 0 when the client ended the wire (clean), 1 when the
 * downstream agent died first (a dead agent is not a clean session).
 */
