// bro-adapter — ownership sentinel for `bro plugins` (isBroAdapter); do not remove
/**
 * bro — the OpenCode RPC contract.
 *
 * One typed contract, three consumers:
 *
 *   - the server part registers it (`ctx.rpc.register(Bro, impl)`);
 *   - the TUI part calls it (`context.client.rpc(Bro)`) and subscribes to
 *     its events;
 *   - bro's CLI (or any other client) calls it over HTTP —
 *     `POST /api/rpc/bro/<method>`.
 *
 * The point of the contract is that bro can push INTO opencode, not only
 * read out of it: `notify` lands a message in a session, `prompt` runs a
 * turn, `board` returns the current orchestration state, and the
 * `changed`/`attention` events let bro announce state shifts to every
 * subscribed TUI at once.
 *
 * The contract is a plain module with no imports beyond `@opencode/plugin`
 * so that the CLI, the server part and the TUI part can all import the
 * SAME file — a drifted copy would mean a typed contract that lies.
 *
 * JSON Schema, not a validator library: the contract must be importable
 * by a client that has no dependencies at all.
 */
import { Rpc } from '@opencode/plugin/rpc';

/** One bead on the board. */
export interface BroBead {
  id: string;
  title: string;
  assignee?: string;
}

/** One fleet agent. */
export interface BroAgent {
  id: string;
  state: string;
  provider?: string;
  model?: string;
  worktree?: string;
  pid?: number;
  step?: string;
}

/** One convoy/loop run. */
export interface BroRun {
  slug: string;
  state: string;
  startedAt?: number;
}

/** The board snapshot bro hands to opencode — the same shape the TUI
 *  widget renders and `bro status --json` prints. The server parses
 *  `bro status --json` ONCE; every consumer reads the result from here,
 *  so the sidebar and the RPC can never disagree about the board. */
export interface BroBoard {
  /** Uncommitted changes in the worktree. */
  dirty: number;
  /** Repo root the board was read from. */
  dir?: string;
  /** Current branch. */
  branch?: string;
  /** Beads currently in work. */
  inWork: BroBead[];
  /** Beads ready to pick up. */
  ready: BroBead[];
  /** Total ready count — the list is truncated, the count is not. */
  readyTotal: number;
  /** Live fleet agents. */
  agents: BroAgent[];
  /** Fleet capacity (max concurrent agents). */
  fleetMax: number;
  /** Convoy/loop runs. */
  runs: BroRun[];
  /** The watch heartbeat — absent when nothing is watching. */
  watch?: { ageMs: number; attention: number };
  /** Unfinished PR review work, when a gate is open. */
  act?: { pr: number; url: string };
  /** Worktrees in the rig. */
  worktrees: { name: string; branch?: string; path?: string }[];
  /** Attention items bro wants a human to look at. */
  attention: number;
}

const bead = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    assignee: { type: 'string' },
  },
  required: ['id', 'title'],
  additionalProperties: false,
} as const;

const agent = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    state: { type: 'string' },
    provider: { type: 'string' },
    model: { type: 'string' },
    worktree: { type: 'string' },
    pid: { type: 'number' },
    step: { type: 'string' },
  },
  required: ['id', 'state'],
  additionalProperties: false,
} as const;

const run = {
  type: 'object',
  properties: {
    slug: { type: 'string' },
    state: { type: 'string' },
    startedAt: { type: 'number' },
  },
  required: ['slug', 'state'],
  additionalProperties: false,
} as const;

const boardOutput = {
  type: 'object',
  properties: {
    dirty: { type: 'number' },
    dir: { type: 'string' },
    branch: { type: 'string' },
    inWork: { type: 'array', items: bead },
    ready: { type: 'array', items: bead },
    readyTotal: { type: 'number' },
    agents: { type: 'array', items: agent },
    fleetMax: { type: 'number' },
    runs: { type: 'array', items: run },
    watch: {
      type: 'object',
      properties: {
        ageMs: { type: 'number' },
        attention: { type: 'number' },
      },
      required: ['ageMs', 'attention'],
      additionalProperties: false,
    },
    act: {
      type: 'object',
      properties: { pr: { type: 'number' }, url: { type: 'string' } },
      required: ['pr', 'url'],
      additionalProperties: false,
    },
    worktrees: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          branch: { type: 'string' },
          path: { type: 'string' },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
    attention: { type: 'number' },
  },
  required: [
    'dirty',
    'inWork',
    'ready',
    'readyTotal',
    'agents',
    'fleetMax',
    'runs',
    'worktrees',
    'attention',
  ],
  additionalProperties: false,
} as const;

export const Bro = Rpc.define({
  id: 'bro',
  methods: {
    /** The current orchestration board. */
    board: {
      input: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      output: boardOutput,
    },

    /** Deliver a message to a session WITHOUT running a turn — a nudge,
     *  a board summary, a review-thread notice. */
    notify: {
      input: {
        type: 'object',
        properties: {
          sessionID: { type: 'string' },
          text: { type: 'string' },
          title: { type: 'string' },
          variant: { type: 'string', enum: ['info', 'success', 'warning', 'error'] },
        },
        required: ['text'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: { delivered: { type: 'boolean' } },
        required: ['delivered'],
        additionalProperties: false,
      },
      errors: {
        no_session: {
          type: 'object',
          properties: { sessionID: { type: 'string' } },
          required: ['sessionID'],
          additionalProperties: false,
        },
      },
    },

    /** Run a turn in a session — the "bro talks to the agent" path. */
    prompt: {
      input: {
        type: 'object',
        properties: {
          sessionID: { type: 'string' },
          text: { type: 'string' },
          agent: { type: 'string' },
        },
        required: ['sessionID', 'text'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: { accepted: { type: 'boolean' } },
        required: ['accepted'],
        additionalProperties: false,
      },
      errors: {
        no_session: {
          type: 'object',
          properties: { sessionID: { type: 'string' } },
          required: ['sessionID'],
          additionalProperties: false,
        },
      },
    },
  },
  events: {
    /** The board changed — in-work set, ready set, fleet load. */
    changed: {
      schema: {
        type: 'object',
        properties: {
          inWork: { type: 'number' },
          ready: { type: 'number' },
          agents: { type: 'number' },
        },
        required: ['inWork', 'ready', 'agents'],
        additionalProperties: false,
      },
    },
    /** Something wants a human — an open PR gate, a blocked drill. */
    attention: {
      schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          message: { type: 'string' },
          severity: { type: 'string', enum: ['info', 'warning', 'error'] },
        },
        required: ['title', 'message', 'severity'],
        additionalProperties: false,
      },
    },
  },
});

/** The RPC id as it appears in the HTTP route (`/api/rpc/bro/board`). */
export const BRO_RPC_ID = Bro.id;

export type { BroBoard as BoardState };

/* board parsing                                                         */
/* -------------------------------------------------------------------- */

/** `bro status --json` is the raw wire format; this turns it into the
 *  board the contract publishes and the TUI renders. It lives in ONE
 *  place on purpose: the server part serves the parsed board over RPC
 *  and the TUI part reads THAT — so the sidebar and the RPC can never
 *  disagree about what the board is.
 *
 *  Every field is defensive: JSON arrives unverified, and one malformed
 *  row must drop that row, never the whole board. */

/** JSON numbers arrive unverified — counts, pids and epoch stamps are
 *  integers by contract; a float (or non-number coerced by Number())
 *  means the payload is not what `bro status` emits. */
const asInt = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) ? value : undefined;

/** JSON array elements may be null or primitives — read fields only off
 *  real objects or the cast crashes the whole board parse. */
const asObj = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;

function parseBeads(value: unknown): BroBead[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(row => {
    const o = asObj(row);
    if (o === null) return [];
    if (typeof o.id !== 'string' || typeof o.title !== 'string') return [];
    const bead: BroBead = { id: o.id, title: o.title };
    if (typeof o.assignee === 'string') bead.assignee = o.assignee;
    return [bead];
  });
}

function parseAgents(value: unknown): BroAgent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(row => {
    const o = asObj(row);
    if (o === null) return [];
    if (typeof o.id !== 'string' || typeof o.state !== 'string') return [];
    const agent: BroAgent = { id: o.id, state: o.state };
    if (typeof o.provider === 'string') agent.provider = o.provider;
    if (typeof o.model === 'string') agent.model = o.model;
    if (typeof o.worktree === 'string') agent.worktree = o.worktree;
    const pid = asInt(o.pid);
    if (pid !== undefined) agent.pid = pid;
    if (typeof o.step === 'string') agent.step = o.step;
    return [agent];
  });
}

function parseRuns(value: unknown): BroRun[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(row => {
    const o = asObj(row);
    if (o === null) return [];
    if (typeof o.slug !== 'string' || typeof o.state !== 'string') return [];
    const run: BroRun = { slug: o.slug, state: o.state };
    const startedAt = asInt(o.startedAt);
    if (startedAt !== undefined) run.startedAt = startedAt;
    return [run];
  });
}

function parseWorktrees(value: unknown): BroBoard['worktrees'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(row => {
    const o = asObj(row);
    if (o === null) return [];
    if (typeof o.name !== 'string') return [];
    const wt: BroBoard['worktrees'][number] = { name: o.name };
    if (typeof o.branch === 'string') wt.branch = o.branch;
    if (typeof o.path === 'string') wt.path = o.path;
    return [wt];
  });
}

/** The empty board — a rig with no bro, a failed read, a parse error.
 *  The widget hides on an empty board; the RPC still answers. */
export function emptyBoard(): BroBoard {
  return {
    dirty: 0,
    inWork: [],
    ready: [],
    readyTotal: 0,
    agents: [],
    fleetMax: 0,
    runs: [],
    worktrees: [],
    attention: 0,
  };
}

/** Parse `bro status --json` output into the board. Unparseable output
 *  yields the EMPTY board — never a throw, never a partial lie. */
export function parseBoard(out: string): BroBoard {
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    return emptyBoard();
  }
  const o = asObj(parsed);
  if (o === null) {
    return emptyBoard();
  }
  const beads = asObj(o.beads) ?? {};
  const fleet = asObj(o.fleet) ?? {};
  const loop = asObj(o.loop) ?? {};
  const watch = asObj(o.watch);
  const act = asObj(o.act);
  const board: BroBoard = {
    dirty: asInt(o.dirty) ?? 0,
    inWork: parseBeads(beads.inProgress),
    ready: parseBeads(beads.ready),
    readyTotal: asInt(beads.readyTotal) ?? 0,
    agents: parseAgents(fleet.agents),
    fleetMax: asInt(fleet.maxConcurrent) ?? 0,
    runs: parseRuns(loop.runs),
    worktrees: parseWorktrees(o.worktrees),
    attention: asInt(o.attention) ?? 0,
  };
  if (typeof o.dir === 'string') board.dir = o.dir;
  if (typeof o.branch === 'string') board.branch = o.branch;
  if (watch !== null) {
    board.watch = { ageMs: asInt(watch.ageMs) ?? 0, attention: asInt(watch.attention) ?? 0 };
  }
  if (act !== null && typeof act.pr === 'number' && typeof act.url === 'string') {
    board.act = { pr: act.pr, url: act.url };
  }
  return board;
}

/** Is this board worth showing? A rig with nothing in it is an ordinary
 *  state, not an error — the widget stays hidden. */
export function boardHasContent(board: BroBoard): boolean {
  return (
    board.inWork.length > 0 ||
    board.ready.length > 0 ||
    board.agents.length > 0 ||
    board.runs.length > 0 ||
    board.attention > 0 ||
    board.act !== undefined
  );
}
