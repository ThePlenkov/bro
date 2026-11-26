// bro-adapter — ownership sentinel for `bro plugins` (isBroAdapter); do not remove
/** @jsxImportSource @opentui/solid */
/**
 * bro — OpenCode V2 TUI plugin (`tui.tsx`), the terminal half of the
 * integration. It is the TUI part of the SAME package as the server part
 * and the RPC contract — opencode only loads a TUI part for a package
 * that also has a server, so a loose file cannot work.
 *
 *   sidebar.content     the bro board — in-work beads, ready set, fleet
 *                       load, watch heartbeat; refreshed over RPC
 *   session.panel       the board as a full panel, opened from a command
 *   `/bro [args]`       slash + palette command → `bro <args>` → toast
 *   attention           an RPC `attention` event → toast + a sound
 *
 * The board comes from the server part over the `bro` RPC contract — the
 * TUI never spawns bro itself, so the sidebar and the model tools can
 * never disagree about the board.
 *
 * Host-provided imports (`@opencode/plugin`, `solid-js`, `@opentui/*`)
 * resolve against opencode's own modules — the artifact needs no
 * node_modules beside it. Every call is optional-chained and fail-quiet:
 * a missing server degrades to "no board", never a crash.
 */
import { Plugin } from '@opencode/plugin/tui';
import { For, Show, createSignal } from 'solid-js';
import { Bro, type BroBoard, boardHasContent } from './rpc.ts';

/** The board as the TUI holds it — the RPC shape, plus the moment it
 *  was read (the widget shows "watched Ns ago"). */
interface BoardView extends BroBoard {
  /** Epoch ms of the read that produced this snapshot. */
  readAt: number;
}

/** Refresh cadence — the board is a local read on the server side. */
const POLL_MS = 15_000;

/** Retry ladder for the first read — the server half registers its RPC
 *  while the host finishes loading the plugin, and a TUI that starts
 *  first would otherwise wait a whole poll interval for the board. */
const RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000];

function ageStr(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

function fmtDuration(ms?: number): string {
  if (ms === undefined || ms === null || ms <= 0) return '?';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

function shortId(id: string): string {
  return id.startsWith('bro-') ? id.slice(4) : id;
}

function clip(text: string, max = 3_000): string {
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}

/** `/bro` arguments — whitespace-split with "…"/'…' holding a multiword
 *  value together. Unmatched quotes degrade to the plain token. */
function splitArgs(input: string): string[] {
  const args: string[] = [];
  for (const m of input.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    args.push(m[1] ?? m[2] ?? m[3] ?? m[0]);
  }
  return args;
}

/* board rendering                                                       */
/* -------------------------------------------------------------------- */

function InWorkItem(props: {
  b: { id: string; title: string };
  board: () => BoardView | null;
  theme: any;
}) {
  const cur = props.board();
  if (cur === null) return null;
  const theme = props.theme;
  const b = props.b;
  const pr = cur.act;
  return (
    <box flexDirection="column" marginBottom={1}>
      <text wrapMode="none" truncate>
        <span style={{ fg: theme.text.feedback.info.base }}>●</span> <b>{shortId(b.id)}</b>{' '}
        <span style={{ fg: theme.text.muted }}>
          {b.title.length > 40 ? `${b.title.slice(0, 40)}…` : b.title}
        </span>
      </text>
      <box flexDirection="row" gap={1} paddingLeft={2}>
        <Show when={pr}>
          <text fg={theme.text.feedback.info.base}>
            <u>#{pr!.pr}</u>
          </text>
        </Show>
      </box>
    </box>
  );
}

function InWorkSection(props: { board: () => BoardView | null; theme: any }) {
  const board = props.board;
  return (
    <Show when={(board()?.inWork.length ?? 0) > 0}>
      <text fg={props.theme.text.muted}>in work</text>
      <For each={board()?.inWork.slice(0, 6) ?? []}>
        {b => <InWorkItem b={b} board={board} theme={props.theme} />}
      </For>
    </Show>
  );
}

function ReadyRow(props: { b: { id: string; title: string }; theme: any }) {
  const theme = props.theme;
  const title = props.b.title.length > 40 ? `${props.b.title.slice(0, 40)}…` : props.b.title;
  return (
    <box flexDirection="row" gap={1} minWidth={0}>
      <text flexShrink={0} style={{ fg: theme.text.muted }}>
        ○
      </text>
      <text fg={theme.text.muted} wrapMode="none" truncate flexGrow={1} flexShrink={1} minWidth={0}>
        <b>{shortId(props.b.id)}</b> {title}
      </text>
    </box>
  );
}

function ReadySection(props: { board: () => BoardView | null; theme: any }) {
  const board = props.board;
  return (
    <Show when={(board()?.readyTotal ?? 0) > 0}>
      <text fg={props.theme.text.muted}>ready ({board()?.readyTotal})</text>
      <For each={board()?.ready.slice(0, 4) ?? []}>
        {b => <ReadyRow b={b} theme={props.theme} />}
      </For>
    </Show>
  );
}

function FleetSection(props: { board: () => BoardView | null; theme: any }) {
  const board = props.board;
  const theme = props.theme;
  const live = () => (board()?.agents ?? []).filter(a => a.state === 'running');
  const running = () => (board()?.runs ?? []).filter(r => r.state === 'running');
  return (
    <Show when={live().length > 0 || running().length > 0}>
      <text fg={theme.text.muted}>
        fleet {live().length}
        <Show when={(board()?.fleetMax ?? 0) > 0}>/{board()!.fleetMax}</Show>
        <Show when={running().length > 0}> · loop ×{running().length}</Show>
      </text>
      <For each={live().slice(0, 3)}>
        {a => (
          <text fg={theme.text.muted} wrapMode="none" truncate>
            {'  '}
            <span style={{ fg: theme.text.feedback.success.base }}>●</span> {a.id}
          </text>
        )}
      </For>
    </Show>
  );
}

function WatchSection(props: { board: () => BoardView | null; theme: any }) {
  const board = props.board;
  const theme = props.theme;
  return (
    <Show when={board()?.watch}>
      {w => (
        <text fg={w().attention > 0 ? theme.text.feedback.warning.base : theme.text.muted}>
          watch {ageStr(w().ageMs)} ago
          <Show when={w().attention > 0}> · {w().attention} attention</Show>
        </text>
      )}
    </Show>
  );
}

function BoardBody(props: { board: () => BoardView | null; theme: any }) {
  const board = props.board;
  const theme = props.theme;
  return (
    <>
      <InWorkSection board={board} theme={theme} />
      <ReadySection board={board} theme={theme} />
      <FleetSection board={board} theme={theme} />
      <WatchSection board={board} theme={theme} />
      <Show when={(board()?.dirty ?? 0) > 0}>
        <text fg={theme.text.feedback.warning.base}>dirty ×{board()!.dirty}</text>
      </Show>
    </>
  );
}

/** The collapsible board — the sidebar widget. */
function BroBoardWidget(props: { context: Plugin.Context; board: () => BoardView | null }) {
  const theme = props.context.theme;
  const [view, updateView] = props.context.storage.store('bro.view', {
    initial: { open: true },
  });
  const board = () => props.board();
  return (
    <Show when={board() !== null && boardHasContent(board()!)}>
      <box flexDirection="column">
        <box
          flexDirection="row"
          gap={1}
          onMouseDown={() => {
            void updateView(draft => {
              draft.open = !draft.open;
            }).catch(() => {});
          }}
        >
          <text fg={theme.text.base}>{view.open ? '▼' : '▶'}</text>
          <text fg={theme.text.base}>
            <b>bro</b>
            <Show when={!view.open && board() !== null}>
              <span style={{ fg: theme.text.muted }}>
                {' '}
                ({board()!.inWork.length} in work, {board()!.readyTotal} ready
                {board()!.watch ? `, ${board()!.watch!.attention} attention` : ''})
              </span>
            </Show>
          </text>
        </box>
        <Show when={view.open}>
          <BoardBody board={board} theme={theme} />
        </Show>
      </box>
    </Show>
  );
}

/** The session panel — the same board, full width, with a header. */
function BroBoardPanel(props: {
  context: Plugin.Context;
  board: () => BoardView | null;
  panel: any;
}) {
  const theme = props.context.theme;
  const board = props.board;
  return (
    <box flexDirection="column" paddingLeft={1}>
      <text fg={theme.text.base}>
        <b>bro board</b>
        <Show when={board()?.branch}>
          <span style={{ fg: theme.text.muted }}> · {board()!.branch}</span>
        </Show>
      </text>
      <Show
        when={board() !== null && boardHasContent(board()!)}
        fallback={<text fg={theme.text.muted}>nothing in work — the rig is idle</text>}
      >
        <BoardBody board={board} theme={theme} />
      </Show>
    </box>
  );
}

/* the plugin                                                            */
/* -------------------------------------------------------------------- */

export default Plugin.define({
  id: 'bro.cli',
  setup(context) {
    const toast = context.ui.toast;
    const theme = context.theme;

    // The board comes from the server part over the RPC contract. The
    // client is re-read on every call — it changes when the server
    // restarts, and a stale client would reject forever.
    const client = () => context.client;

    const [board, setBoard] = createSignal<BoardView | null>(null);
    let refreshing = false;
    // The server half registers its RPC when the host finishes loading the
    // plugin — a TUI that starts first would read an unregistered contract
    // and leave the sidebar blank for a whole poll interval. The retry
    // ladder fills that window; after it, the poll interval owns it.
    let failures = 0;
    const refresh = async (): Promise<void> => {
      if (refreshing) return;
      refreshing = true;
      try {
        const board = await client().rpc(Bro).board({});
        if (board === null || typeof board !== 'object') {
          return;
        }
        failures = 0;
        setBoard({ ...(board as BroBoard), readAt: Date.now() });
      } catch {
        // the server part is not there (or the rig has no bro) — keep the
        // last board rather than blanking the sidebar on a transient error
        failures += 1;
        const delay = RETRY_DELAYS_MS[failures - 1];
        if (delay !== undefined) {
          const timer = setTimeout(() => {
            void refresh();
          }, delay);
          stops.push(() => clearTimeout(timer));
        }
      } finally {
        refreshing = false;
      }
    };

    const stops: (() => void)[] = [];

    // The contract's events: `changed` refreshes the board, `attention`
    // is the "something wants a human" signal — a toast plus a sound.
    try {
      const sub = client().rpc(Bro);
      stops.push(
        sub.events.on('changed', () => {
          void refresh();
        })
      );
      stops.push(
        sub.events.on('attention', event => {
          const data = event?.data as { title?: string; message?: string; severity?: string };
          const title = typeof data?.title === 'string' && data.title !== '' ? data.title : 'bro';
          const message = typeof data?.message === 'string' ? data.message : '';
          const severity =
            data?.severity === 'error'
              ? 'error'
              : data?.severity === 'warning'
                ? 'warning'
                : 'info';
          toast.show({
            title: `bro • ${title}`,
            message: clip(message),
            variant: severity,
            duration: 10_000,
          });
          // the sound comes from the host's attention config — bro only
          // names the event, never plays a file itself
          void context.attention
            .notify({
              title,
              message,
              sound: { name: severity === 'error' ? 'error' : 'default' },
            })
            .catch(() => {});
        })
      );
    } catch {
      // no RPC client — the board poll below still works
    }

    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    timer.unref?.();

    // The palette/slash command — runs a bro verb and shows the output.
    context.keymap.layer(() => ({
      mode: 'global',
      commands: [
        {
          id: 'bro.status',
          title: 'Show bro status',
          group: 'bro',
          palette: true,
          slash: { name: 'bro', arguments: true },
          run: async (input?: string) => {
            const args = splitArgs(input ?? '');
            const verb = args.length > 0 ? args : ['status'];
            try {
              const result = await client().rpc(Bro).board({});
              const board = result as BroBoard | undefined;
              const body =
                verb.length === 1 && verb[0] === 'status'
                  ? [
                      `in work: ${board?.inWork.length ?? 0}`,
                      `ready: ${board?.readyTotal ?? 0}`,
                      `agents: ${board?.agents.length ?? 0}`,
                      board?.act ? `PR #${board.act.pr} needs attention` : '',
                    ]
                      .filter(l => l !== '')
                      .join('\n')
                  : `bro ${verb.join(' ')} — the board is above`;
              toast.show({
                title: `bro ${verb.join(' ')}`,
                message: clip(body),
                variant: 'info',
                duration: 10_000,
              });
            } catch {
              toast.show({
                title: `bro ${verb.join(' ')}`,
                message: 'bro is not reachable from this opencode',
                variant: 'warning',
                duration: 8000,
              });
            }
          },
        },
        {
          id: 'bro.board',
          title: 'Open the bro board',
          group: 'bro',
          palette: true,
          run: () => {
            void refresh();
            context.ui.panel.open('bro.board');
          },
        },
      ],
      bindings: ['bro.status', 'bro.board'],
    }));

    const releaseSlot = context.ui.slot({
      append: 'sidebar.content',
      render: () => <BroBoardWidget context={context} board={board} />,
    });

    const releasePanel = context.ui.slot({
      append: 'session.panel',
      render: (panel: any) => (
        <Show when={panel?.name === 'bro.board'}>
          <BroBoardPanel context={context} board={board} panel={panel} />
        </Show>
      ),
    });

    return () => {
      clearInterval(timer);
      releaseSlot();
      releasePanel();
      for (const stop of stops) {
        try {
          stop();
        } catch {
          // an already-closed subscription must not break teardown
        }
      }
    };
  },
});
