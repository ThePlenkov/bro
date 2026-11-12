/**
 * `bro msg <session|role> <text>` — the fleet F4 session message
 * (specs/sessions/bro-izpyk.md "Messages and tasks"; impl
 * specs/bro-izpyk.4.md).
 *
 *   bro msg claude:3f2a… "status?"        a session key
 *   bro msg fixer-7 "ship it"             an agentId or sid (ledger-resolved)
 *   bro msg orchestrator "heads up"       the role — sessions with no spawnedBy
 *
 * Delivery picks one channel per resolved session: inbox-capable hosts
 * (claude|codex|cursor|devin) get the F4 inbox file — run.sh's Tier-0
 * `[ -s ]` check wakes Node on that session's next hook in EVERY mode —
 * plus an events publish `to: '<host>:<sid>'` as the record. Everyone
 * else (unknown hosts, sessions the ledger has not seen, ended rows'
 * records) publishes through the events facade with the mailbox
 * vocabulary, exactly like `bro notify --to`.
 *
 * Flags ride the notify vocabulary: --kind note|info|ask|result|block
 * (default note), --in-reply-to <ref>, --key <k> (coalescing).
 */
import {
  CommandError,
  EXIT,
  facade,
  hasHelpFlag,
  loadConfig,
  printUsage,
  type EventsFacade,
  type LedgerFacade,
} from '@broject/core';
import { flag, positionals } from './args.ts';
import { sendSessionMessage } from './session-msg.ts';

const KINDS = new Set(['note', 'info', 'ask', 'result', 'block']);
const VALUE_FLAGS = new Set(['--kind', '--in-reply-to', '--key']);

/** Test seams — production resolves facades through `facade()` so a
 *  `connectors.ledger`/`connectors.events` pin is honored; tests inject
 *  stubs and an env with a temp XDG_STATE_HOME. */
export interface MsgDeps {
  dir?: string;
  env?: NodeJS.ProcessEnv;
  ledger?: LedgerFacade;
  events?: EventsFacade;
}

const USAGE = `usage: bro msg [--kind <k>] [--in-reply-to <r>] [--key <k>] [--] <session|role> <text>

  <session|role>  <host>:<sid> session key · <sid> or <agentId> · orchestrator
  --kind <k>       note|info|ask|result|block (default note) — a label, never a grant
  --in-reply-to    the drop/bead/step this answers
  --key <k>        coalesce: a pending same-key drop from this source is superseded

Delivery: ledger-resolved sessions on claude|codex|cursor|devin get the
per-session inbox file (Tier-0 delivery on their next hook); everything
else publishes through the events facade's mailbox address.`;

export async function runMsgCommand(argv: string[], deps: MsgDeps = {}): Promise<void> {
  if (hasHelpFlag(argv)) {
    printUsage(USAGE, EXIT.ok);
  }
  // strict: msg knows every --flag it takes — anything else is a
  // typo'd option, never message text silently dropped. `--` ends flag
  // parsing so a text containing an option-looking word survives.
  const pos = positionals(argv, VALUE_FLAGS, { strict: true });
  const kind = flag(argv, '--kind');
  const inReplyTo = flag(argv, '--in-reply-to');
  const key = flag(argv, '--key');
  if (kind !== undefined && !KINDS.has(kind)) {
    throw new CommandError(`error: --kind must be one of: ${[...KINDS].join(', ')}`, EXIT.usage);
  }
  if (pos.length < 2) {
    throw new CommandError(
      'usage: bro msg [--kind <k>] [--in-reply-to <r>] [--key <k>] [--] <session|role> <text>',
      EXIT.usage
    );
  }
  const [target, ...words] = pos;
  const text = words.join(' ').trim();
  if (text === '') {
    throw new CommandError(
      'usage: bro msg [--kind <k>] [--in-reply-to <r>] [--key <k>] [--] <session|role> <text>',
      EXIT.usage
    );
  }
  const dir = deps.dir ?? process.cwd();
  const env = deps.env ?? process.env;
  const prefer = loadConfig(dir).connectors;
  const opts = prefer === undefined ? {} : { prefer };
  // The ledger is machine-wide but its facade can still fail (a broken
  // sqlite, a pinned connector that is down) — degrade to mailbox
  // addressing with a warning rather than fail the message outright:
  // `to: <sid>` reaches sessions the ledger cannot see anyway.
  let ledger = deps.ledger;
  if (ledger === undefined) {
    try {
      ledger = facade('ledger', { dir }, opts);
    } catch (err) {
      console.error(
        `warning: session ledger unavailable — resolving by mailbox address only (${
          err instanceof Error ? err.message : String(err)
        })`
      );
    }
  }
  const events = deps.events ?? facade('events', { dir }, opts);
  const res = await sendSessionMessage({
    dir,
    target: target!,
    text,
    env,
    ...(kind !== undefined ? { kind } : {}),
    ...(inReplyTo !== undefined ? { inReplyTo } : {}),
    ...(key !== undefined ? { key } : {}),
    ...(ledger !== undefined ? { ledger } : {}),
    events,
  });
  if (res.error !== undefined || res.deliveries.length === 0) {
    // only reachable through an ambiguous target — the error carries
    // the candidate list
    throw new CommandError(`error: ${res.error ?? 'no delivery'}`, EXIT.usage);
  }
  for (const d of res.deliveries) {
    const via =
      d.channel === 'mailbox' ? 'mailbox' : d.channel === 'inbox' ? 'inbox' : 'inbox+record';
    const locator = d.locator ?? d.inboxPath;
    console.log(`msg → ${d.label} — ${via}${locator !== undefined ? ` (${locator})` : ''}`);
  }
  for (const w of res.warnings) {
    console.error(`warning: ${w}`);
  }
}
