#!/usr/bin/env bun
/**
 * The standalone ACP pane (spec bro-t4uin) — the panel as a clean TUI.
 *
 * One live agent session, a composer that steers it, and no herdr,
 * no mux, no pane in sight:
 *
 *   bun run packages/acp/tui/main.ts --cmd 'opencode acp' [--cwd DIR]
 *                                   [--session ID] [--resume] [--prompt TEXT]
 *
 * The panel is an ACP CLIENT, not a file tail: the session lives in
 * this process, the human's follow-ups queue while a turn runs, a
 * mid-turn Ctrl+X cancels it, and a permission ask is answered by a
 * person — never by a headless driver's default.
 *
 * The split is not cosmetic: the Solid JSX transform and OpenTUI's
 * native FFI are both Bun-only, so `app.tsx` cannot be imported by
 * the Node test runner, while the protocol half
 * (`packages/acp/client`) and the keymap half (`live.ts`) can — and
 * are, under `npm test`.
 */
import { AcpClient, type ClientRow, type PermissionAsk, splitArgv } from '../client/src/index.ts';
import { sanitise } from '../model/src/index.ts';
import { pickImpl } from '../session/src/index.ts';
import {
  type LiveAction,
  type ComposerSubmitEvent,
  liveAction,
  type LiveMode,
  type LiveView,
} from './live.ts';
import { copyRow, serve } from './serve.ts';

/**
 * The Solid runtime must be loaded AFTER the Bun plugin that swaps
 * the SSR build for the client one — the plugin rewrites
 * `solid-js/dist/server.js` on load, so a plain import that lands
 * first caches the wrong build and the tree renders as orphan text.
 * (The static imports above are safe: none of them touch solid-js.)
 */
await import('@opentui/solid/preload');
const { createSignal } = await import('solid-js');

const USAGE = `bro acp pane — the interactive ACP panel

  bun run packages/acp/tui/main.ts --cmd '<agent command>' [options]

  --cmd <line>      the agent's ACP command (default: devin acp)
  --cwd <dir>       the session's working directory (default: .)
  --session <id>    continue an existing session (session/load)
  --resume          continue without replaying (session/resume)
  --prompt <text>   send this prompt as soon as the session is live
  -h, --help        this text

  keys: i compose · j/k select · Enter fold · a/z expand-all
        Ctrl+X cancel the turn · 1-9 answer a permission · d deny
        q quit
`;

interface Args {
  cmd: string;
  cwd: string;
  session?: string;
  resume: boolean;
  prompt?: string;
  help: boolean;
}

/** The argv — a tiny parser; the pane's options are few and flat. */
function parseArgs(argv: readonly string[]): Args {
  const out: Args = { cmd: 'devin acp', cwd: process.cwd(), resume: false, help: false };
  // a table, not a chain — the pane's grammar is a lookup: flag → the
  // field its value lands in. Boolean flags carry no field of their own
  const VALUE_FLAGS: Record<string, 'cmd' | 'cwd' | 'session' | 'prompt'> = {
    '--cmd': 'cmd',
    '--cwd': 'cwd',
    '--session': 'session',
    '--prompt': 'prompt',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const flag = VALUE_FLAGS[arg];
    if (flag !== undefined) {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      out[flag] = value;
      continue;
    }
    const inline = Object.entries(VALUE_FLAGS).find(([f]) => arg.startsWith(`${f}=`));
    if (inline !== undefined) {
      out[inline[1]] = arg.slice(inline[0].length + 1);
      continue;
    }
    if (arg === '--resume') out.resume = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

/** The pane's own run — the shell around the session. */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }
  const command = splitArgv(args.cmd);
  if (command.length === 0) throw new Error('--cmd must name an executable');

  // the same impl the archive replay uses — the live feed and the
  // file replay are ONE renderer, so a row looks the same either way
  const impl = await pickImpl('acp');
  // a live session is never a replay — the impl opens its model in
  // 'load' mode (that is how an archive arrives), and the live pane
  // says so right away, before the first frame
  impl.beginLive();

  const [mode, setMode] = createSignal<LiveMode>('browse');
  const [queue, setQueue] = createSignal<{ ordinal: number; text: string }[]>([]);
  const [ask, setAsk] = createSignal<PermissionAsk | undefined>(undefined);
  const [status, setStatus] = createSignal('starting');

  /** Rows that landed before the pane existed — the handshake can
   *  finish before the tree is mounted. */
  const pending: ClientRow[] = [];
  let pane: Awaited<ReturnType<typeof serve>>['pane'] | undefined;

  const client = new AcpClient({
    command,
    cwd: args.cwd,
    ...(args.session !== undefined ? { sessionId: args.session } : {}),
    useResume: args.resume,
    onRow: row => {
      if (pane === undefined) {
        pending.push(row);
        return;
      }
      impl.feed(row);
      flush();
    },
    onState: () => {
      setQueue(client.pendingPrompts);
      setAsk(sanitisedAsk(client.awaitingPermission));
      setStatus(client.status);
    },
    onNote: line => {
      // the agent's stderr is a diagnostic, not feed — it goes to the
      // pane's own stderr so it never lands in the alternate screen
      process.stderr.write(`${line}\n`);
    },
  });

  /** The ops the impl produced since the last drain — the pane's
   *  currency, exactly as in the archive replay. */
  const flush = (): void => {
    if (pane === undefined) return;
    const ops = impl.drain();
    if (ops.length > 0) pane.writer.apply(ops);
    const verdict = impl.verdict;
    if (verdict !== undefined) {
      pane.writer.setMeta({ led: verdict.led.state, mode: verdict.mode });
    }
  };

  /**
   * The pending ask, with the agent's text sanitised for APPROVAL.
   *
   * The bar is where a human decides — so it gets the approval mode
   * (bidi overrides and zero-width characters stripped): the text
   * presented must be the text read, or the agent could word its own
   * ask into something it is not.
   */
  const sanitisedAsk = (ask: PermissionAsk | undefined): PermissionAsk | undefined =>
    ask === undefined
      ? undefined
      : {
          ...ask,
          title: sanitise(ask.title, 'approval'),
          options: ask.options.map(o => ({ ...o, name: sanitise(o.name, 'approval') })),
        };

  /** What the pane knows right now — the keymap reads this. */
  const view = (): LiveView => ({
    mode: mode(),
    queue: queue(),
    permission: ask(),
    status: status(),
  });

  /** The human pressed Enter in the composer — send the words. The
   *  client NEVER rejects for busy: a prompt that arrives during a
   *  turn queues, and the queue is visible under the composer. */
  const send = (payload: string | ComposerSubmitEvent): void => {
    const text = typeof payload === 'string' ? payload : (pane?.input?.value ?? '');
    const trimmed = text.trim();
    if (trimmed === '') return;
    if (pane?.input !== undefined) pane.input.value = '';
    // the client queues the prompt while the session is opening and
    // refuses it when the session is gone — a refusal must be SEEN,
    // never an unhandled rejection that eats the human's words
    void client.prompt(trimmed).catch((err: unknown) => {
      served.pane.toast?.(`the prompt was not sent: ${err instanceof Error ? err.message : err}`);
    });
  };

  const served = await serve({
    // the agent's name lands with the handshake — until then the
    // header says nothing rather than echoing the whole command line
    meta: { worktree: args.cwd },
    composer: {
      composing: () => mode() === 'compose',
      queue: () => queue(),
      permission: () => ask(),
      onSubmit: send,
    },
    keys: (_pane, key) => {
      const action = liveAction(key, view());
      // a table, not a switch — the effect of each action kind is one
      // small handler; the grammar already lives in live.ts's tables
      const answerAsk = (index: number): void => {
        const pendingAsk = ask();
        const option = pendingAsk?.options[index];
        if (pendingAsk === undefined || option === undefined) return;
        if (!client.answerPermission(pendingAsk.requestId, option.optionId)) {
          served.pane.toast?.('the agent refused that answer');
        }
      };
      const EFFECTS: { [K in LiveAction['kind']]?: (a: Extract<LiveAction, { kind: K }>) => void } =
        {
          // the key that opens the composer must NOT land in it — the
          // global handler runs before the focused input, so the 'i'
          // would otherwise be typed as the first letter
          compose: () => {
            key.preventDefault();
            setMode('compose');
          },
          browse: () => {
            key.preventDefault();
            setMode('browse');
            // the input keeps the focus unless it is told otherwise — a
            // focused input would swallow j/k/Enter from the pane
            served.pane.blurComposer?.();
          },
          cancel: () => {
            key.preventDefault();
            if (!client.cancel()) served.pane.toast?.('nothing to cancel');
          },
          answer: a => answerAsk(a.index),
          deny: () => {
            const pendingAsk = ask();
            if (pendingAsk === undefined) return;
            client.denyPermission(pendingAsk.requestId);
          },
          select: a => served.pane.writer.select(a.delta),
          fold: () => served.pane.writer.toggle(),
          'expand-all': () => served.pane.writer.toggleAll(true),
          'collapse-all': () => served.pane.writer.toggleAll(false),
          copy: () => copyRow(served.pane),
          scroll: a => served.pane.scroll?.(a.lines),
          page: a => served.pane.scrollPage?.(a.dir),
          edge: a => served.pane.scrollEdge?.(a.edge),
          quit: () => void shutdown(),
        };
      // the kind union is exhaustive — a typed table lookup, never user input
      (EFFECTS[action.kind] as ((a: LiveAction) => void) | undefined)?.(action); // nosemgrep
    },
  });
  pane = served.pane;

  /** Leave — the session dies with the pane, and an unanswered
   *  permission ends as a denial, never as a silent yes. */
  const shutdown = async (): Promise<void> => {
    await client.close();
    served.renderer.destroy();
    process.exit(0);
  };

  // the handshake's rows land now — the tree is up
  for (const row of pending) impl.feed(row);
  flush();

  try {
    const caps = await client.start();
    impl.setContext?.({ worktree: args.cwd, agent: caps.agentName ?? command.join(' ') });
    flush();
    served.pane.writer.setMeta({ agent: caps.agentName ?? command.join(' ') });
    if (args.prompt !== undefined && args.prompt !== '') send(args.prompt);
  } catch (err) {
    served.pane.toast?.(`the agent did not start: ${err instanceof Error ? err.message : err}`);
    process.stderr.write(`bro acp pane: ${err instanceof Error ? err.message : String(err)}\n`);
    await client.close();
    served.renderer.destroy();
    process.exit(1);
  }

  // the pane lives until the human leaves
  await new Promise<void>(resolve => {
    served.renderer.on('destroy', () => resolve());
  });
  await client.close();
}

await main();
