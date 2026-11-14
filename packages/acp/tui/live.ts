/**
 * The interactive pane's brain (spec bro-t4uin) — the composer's
 * state machine, with NO terminal in it.
 *
 * The pane a human drives needs three things the bare protocol does
 * not have: a place to type while a turn runs, a visible queue of
 * what is still waiting, and a permission ask that a PERSON answers.
 * The protocol half lives in `@broject/acp-client` (a persistent
 * session with a prompt queue); this file is the half that maps a
 * key press onto that session's verbs.
 *
 * It is deliberately framework-free — no Solid, no OpenTUI — so the
 * keymap is unit-testable under Node, and so the herdr pane and the
 * standalone TUI can share one grammar instead of two.
 */

/**
 * The input's submit payload — OpenTUI's own `SubmitEvent` is an
 * empty interface; the input emits the text it held. The optional
 * `value` keeps the shape honest without pretending to be a DOM
 * event.
 */
export interface ComposerSubmitEvent {
  /** the text the input held when the human pressed Enter */
  readonly value?: string;
}

/** The pane's two modes — browse the feed, or compose a prompt. */
export type LiveMode = 'browse' | 'compose';

/** A permission ask, as the pane sees it (the client's shape). */
export interface LivePermission {
  requestId: number | string;
  title: string;
  options: { optionId: string; name: string; kind: string }[];
}

/** One queued prompt — the human's own words, waiting for their turn. */
export interface LiveQueued {
  ordinal: number;
  text: string;
}

/** What the pane knows about the session right now. */
export interface LiveView {
  mode: LiveMode;
  /** the queued prompts, in order — the pane renders them as pending */
  queue: readonly LiveQueued[];
  /** the ask waiting for a human, if any */
  permission: LivePermission | undefined;
  /** the session's status line ('live', 'busy', 'closed', …) */
  status: string;
}

/** A key press — OpenTUI's `KeyEvent` satisfies this structurally. */
export interface LiveKey {
  name: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
}

/** What a key press means. The shell performs it; this file decides. */
export type LiveAction =
  /** enter compose mode — the composer takes the focus */
  | { kind: 'compose' }
  /** leave compose mode — the draft stays, the queue is untouched */
  | { kind: 'browse' }
  /** cancel the running turn — the queue survives it */
  | { kind: 'cancel' }
  /** answer the pending permission with its Nth option */
  | { kind: 'answer'; index: number }
  /** deny the pending permission */
  | { kind: 'deny' }
  | { kind: 'select'; delta: number }
  | { kind: 'fold' }
  | { kind: 'expand-all' }
  | { kind: 'collapse-all' }
  | { kind: 'copy' }
  | { kind: 'scroll'; lines: number }
  | { kind: 'page'; dir: -1 | 1 }
  | { kind: 'edge'; edge: 0 | 1 }
  | { kind: 'quit' }
  /** the key means nothing here */
  | { kind: 'none' };

/**
 * The browse mode's static keys.
 *
 * A TABLE, not a chain of `if`s: the pane's grammar is a lookup, and
 * a lookup reads in one glance. The keys that depend on the session's
 * state (the permission's digits, `d`) cannot live in a table — they
 * are `browseAction`'s job.
 */
const BROWSE_KEYS: Record<string, LiveAction> = {
  i: { kind: 'compose' },
  '/': { kind: 'compose' },
  j: { kind: 'select', delta: 1 },
  k: { kind: 'select', delta: -1 },
  up: { kind: 'scroll', lines: -3 },
  down: { kind: 'scroll', lines: 3 },
  pageup: { kind: 'page', dir: -1 },
  pagedown: { kind: 'page', dir: 1 },
  home: { kind: 'edge', edge: 0 },
  end: { kind: 'edge', edge: 1 },
  a: { kind: 'expand-all' },
  z: { kind: 'collapse-all' },
  return: { kind: 'fold' },
  enter: { kind: 'fold' },
  space: { kind: 'fold' },
  c: { kind: 'fold' },
  q: { kind: 'quit' },
};

/** The control keys — they mean the same thing in every mode. */
function controlAction(name: string): LiveAction {
  if (name === 'c') return { kind: 'copy' };
  // Ctrl+X, not Ctrl+C: Ctrl+C is the pane's copy (and the
  // terminal's own interrupt), and a cancel must not be one keystroke
  // away from a copy.
  if (name === 'x') return { kind: 'cancel' };
  if (name === 'd') return { kind: 'quit' };
  return { kind: 'none' };
}

/** Compose mode — the INPUT owns every key but one. */
function composeAction(name: string): LiveAction {
  if (name === 'escape') return { kind: 'browse' };
  // everything else belongs to the input
  return { kind: 'none' };
}

/** Browse mode — the table, then the permission's own keys. */
function browseAction(name: string, view: LiveView): LiveAction {
  const known = BROWSE_KEYS[name];
  if (known !== undefined) return known;

  // the permission ask owns the number keys and 'd' — but ONLY while
  // it is pending, so the digits stay free otherwise
  const ask = view.permission;
  if (ask === undefined) return { kind: 'none' };
  if (name === 'd') return { kind: 'deny' };
  const index = Number.parseInt(name, 10);
  if (Number.isInteger(index) && index >= 1 && index <= ask.options.length) {
    return { kind: 'answer', index: index - 1 };
  }
  return { kind: 'none' };
}

/**
 * Map a key press onto an action.
 *
 * The rule that shapes everything: in compose mode the INPUT owns
 * every key except the ones this pane must answer itself (cancel,
 * copy, quit). A composer that ate 'j' would make the letter
 * untypeable — so the grammar hands the key over instead of
 * interpreting it.
 */
export function liveAction(key: LiveKey, view: LiveView): LiveAction {
  if (key.ctrl === true) return controlAction(key.name);
  if (view.mode === 'compose') return composeAction(key.name);
  return browseAction(key.name, view);
}

/** The composer hint — the footer tells the human what the keys do. */
export function liveHint(view: LiveView): string {
  if (view.mode === 'compose') {
    return 'Enter send · Esc leave the composer · Ctrl+X cancel the turn';
  }
  if (view.permission !== undefined) {
    return '1-9 answer the permission · d deny · i compose · Ctrl+X cancel';
  }
  return 'i compose · j/k select · Enter fold · Ctrl+X cancel · q quit';
}

/**
 * The queue's own line — the human must SEE that their words are
 * waiting, never assume a sent prompt was read.
 */
export function liveQueueLine(queue: readonly LiveQueued[]): string {
  if (queue.length === 0) return '';
  const next = queue[0];
  const head = `⏳ ${queue.length} queued`;
  const text = next === undefined ? '' : next.text;
  const clipped = text.length > 60 ? `${text.slice(0, 57)}…` : text;
  return clipped === '' ? head : `${head} · next: ${clipped}`;
}

/** The permission bar's line — the options, numbered, and how to say no. */
export function livePermissionLine(ask: LivePermission | undefined): string {
  if (ask === undefined) return '';
  const menu = ask.options.map((o, i) => `${i + 1}) ${o.name}`).join(' · ');
  return menu === ''
    ? `⚠ permission ‹${ask.title}› — d deny`
    : `⚠ permission ‹${ask.title}› — ${menu} · d deny`;
}
