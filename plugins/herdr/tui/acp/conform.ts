/**
 * The seam's conformance probe (spec bro-q2edc, "Phase 2 — the
 * seam"): the same `.events.jsonl` archive through EVERY registered
 * impl — `legacy` and `acp` — with the resulting item coverage
 * compared. The shell contract is the Op stream, so the probe
 * counts on each impl's drain (append/update ops), NOT the
 * eviction-windowed pane state — two impls emitting different item
 * mixes otherwise disagree at the frontier for no real reason.
 *
 *   bun run plugins/herdr/tui/acp/conform.ts <events.jsonl>
 *
 * Parity rules (not identity — the impls model differently):
 *  - tool calls, diffs, turn markers: same count on both
 *  - agent messages: acp may merge chunks differently — compare
 *    coverage loosely (>=), never require identity
 *  - side items: acp absorbs usage/commands/mode into session state,
 *    so its note count is strictly lower — expected, not a failure
 *  - permissions: same count
 */
import { readFileSync } from 'node:fs';
import {
  chunkText,
  type Item,
  parseArchiveRows,
  pickImpl,
} from '../../../../packages/acp/session/src/index.ts';

const path = process.argv[2];
if (path === undefined) {
  console.error('usage: conform.ts <events.jsonl>');
  process.exit(2);
}
const rows = parseArchiveRows(readFileSync(path, 'utf8')); // NOSONAR — argv archive path is this probe's contract

// --- the audit the addendum asks for: archive agent_message_chunks,
// and the tail AFTER the last tool row (user-reported missing output)
let msgChunks = 0;
let postToolChunks = 0;
let postToolChars = 0;
let lastTool = -1;
rows.forEach((row, i) => {
  const u = row.update;
  if (u?.sessionUpdate === 'tool_call' || u?.sessionUpdate === 'tool_call_update') {
    lastTool = i;
  }
  if (u?.sessionUpdate === 'agent_message_chunk') {
    msgChunks++;
  }
});
rows.forEach((row, i) => {
  const u = row.update;
  if (u?.sessionUpdate === 'agent_message_chunk' && i > lastTool) {
    postToolChunks++;
    postToolChars += chunkText(u).length;
  }
});

/** The sibling prompt — fed to every impl like the live pump does. */
const prompt = (() => {
  try {
    return readFileSync(path.replace(/\.events\.jsonl$/, '.prompt.md'), 'utf8');
  } catch {
    return undefined;
  }
})();

interface Stats {
  impl: string;
  appended: number;
  tools: number;
  toolIds: Set<string>;
  toolsWithContent: Set<string>;
  diffs: number;
  messages: number;
  thoughts: number;
  turns: number;
  permissions: number;
  notes: number;
  prompts: number;
  updates: number;
  diffKeys: Set<string>;
  messageChars: number;
  verdict: string;
}
type ToolItem = Extract<Item, { kind: 'tool' }>;

interface RunMember {
  kind: string;
  toolCallId?: string;
  content?: readonly { type: string; path?: string }[];
}

const freshStats = (impl: string, verdict: string): Stats => ({
  impl,
  appended: 0,
  tools: 0,
  toolIds: new Set(),
  toolsWithContent: new Set(),
  diffs: 0,
  messages: 0,
  thoughts: 0,
  turns: 0,
  permissions: 0,
  notes: 0,
  prompts: 0,
  updates: 0,
  diffKeys: new Set(),
  messageChars: 0,
  verdict,
});

/** One activity-run member — the tally line IS the tools, counted
 *  individually. */
const countRunMember = (s: Stats, item: ToolItem, m: RunMember): void => {
  if (m.kind !== 'tool_call') return;
  s.tools++;
  s.toolIds.add(m.toolCallId ?? `run:${item.id}`);
  if ((m.content?.length ?? 0) > 0) {
    s.toolsWithContent.add(m.toolCallId ?? `${item.id}`);
  }
  for (const c of m.content ?? []) {
    if (c.type === 'diff' && c.path !== undefined) {
      s.diffs++;
      s.diffKeys.add(`${m.toolCallId ?? `id:${item.id}`}|${c.path}`);
    }
  }
};

/** An activity-run group covers its members. */
const countRun = (s: Stats, item: ToolItem): void => {
  for (const m of (item.runs ?? []) as RunMember[]) countRunMember(s, item, m);
};

const countToolItem = (s: Stats, item: ToolItem): void => {
  if (item.runs !== undefined) {
    countRun(s, item);
    return;
  }
  s.tools++;
  s.toolIds.add(item.toolCallId);
  if (item.content.length > 0) s.toolsWithContent.add(item.toolCallId);
  s.diffs += item.content.filter(c => c.kind === 'diff').length;
  for (const c of item.content) {
    if (c.kind === 'diff') s.diffKeys.add(`${item.toolCallId}|${c.path}`);
  }
};

/** A tool-op update — a group morph re-projects (recount member
 *  coverage); a content update adds cards and diff keys. */
const countToolUpdate = (s: Stats, t: ToolItem): void => {
  if (t.runs !== undefined) {
    countRun(s, t);
    s.updates++;
    return;
  }
  if (t.content !== undefined && t.content.length > 0) {
    s.toolsWithContent.add(t.toolCallId ?? `${t.id}`);
    s.diffs += t.content.filter(c => c.kind === 'diff').length;
    for (const c of t.content) {
      if (c.kind === 'diff') {
        s.diffKeys.add(`${t.toolCallId ?? `id:${t.id}`}|${c.path}`);
      }
    }
  }
  s.updates++;
};

const countItem = (s: Stats, item: Item): void => {
  switch (item.kind) {
    case 'tool':
      countToolItem(s, item);
      break;
    case 'message':
      s.messages++;
      s.messageChars += item.text.length;
      break;
    case 'thought':
      s.thoughts++;
      break;
    case 'turn':
      s.turns++;
      break;
    case 'prompt':
      s.prompts++;
      break;
    case 'permission':
      s.permissions++;
      break;
    default:
      s.notes++;
  }
};

const run = async (name: string): Promise<Stats> => {
  const impl = await pickImpl(name, {});
  // the .prompt.md fallback — same posture as the live feed: only
  // when the archive itself journals no prompt rows
  if (!rows.some(r => r.kind === 'prompt')) impl.feed({ kind: 'prompt', text: prompt });
  for (const row of rows) impl.feed(row);
  impl.beginLive();
  const s = freshStats(name, impl.verdict?.led.state ?? '?');
  for (const op of impl.drain()) {
    if (op.op === 'append') {
      s.appended++;
      countItem(s, op.item);
    } else if (op.op === 'tool') {
      countToolUpdate(s, op.item as ToolItem);
    } else if (op.op === 'text') {
      s.updates++;
    }
  }
  return s;
};

const legacy = await run('legacy');
const acp = await run('acp');

const fmt = (s: Stats): string =>
  `${s.impl}: appended=${s.appended} tools=${s.tools} wContent=${s.toolsWithContent.size} ` +
  `diffs=${s.diffs} msg=${s.messages} thought=${s.thoughts} turn=${s.turns} ` +
  `perm=${s.permissions} note=${s.notes} updates=${s.updates} verdict=${s.verdict}`;
console.log(fmt(legacy));
console.log(fmt(acp));
console.log(
  `audit: msgChunks=${msgChunks} postToolChunks=${postToolChunks} ` +
    `postToolChars=${postToolChars} prompts=${legacy.prompts}/${acp.prompts}`
);

const problems: string[] = [];
const eq = (label: string, a: number, b: number): void => {
  if (a !== b) problems.push(`${label}: legacy=${a} acp=${b}`);
};
const ge = (label: string, a: number, b: number): void => {
  if (b < a) problems.push(`${label}: legacy=${a} acp=${b} (acp dropped coverage)`);
};

// the wire is the same — every tool call must exist on both
eq('tools', legacy.tools, acp.tools);
if (legacy.toolIds.size !== acp.toolIds.size) {
  const onlyL = [...legacy.toolIds].filter(id => !acp.toolIds.has(id));
  const onlyA = [...acp.toolIds].filter(id => !legacy.toolIds.has(id));
  problems.push(`toolCallIds differ: only-legacy=${onlyL.length} only-acp=${onlyA.length}`);
}
// content coverage: acp never covers fewer cards than legacy
ge('toolsWithContent', legacy.toolsWithContent.size, acp.toolsWithContent.size);
// diffs compare as unique (toolCallId, path) pairs — op streams
// recount the same diff on every content-carrying update
ge('unique diffs', legacy.diffKeys.size, acp.diffKeys.size);
// message items differ at chunk-merge boundaries — coverage is the
// text, not the item count
ge('message text', Math.floor(legacy.messageChars * 0.98), acp.messageChars);
ge('thoughts', legacy.thoughts, acp.thoughts);
eq('turns', legacy.turns, acp.turns);
ge('permissions', legacy.permissions, acp.permissions);
// notes: acp SHOULD carry fewer (usage/commands/mode are session
// state, not items) — flag only if it carries more
if (acp.notes > legacy.notes) problems.push(`notes: acp=${acp.notes} > legacy=${legacy.notes}`);
// the audit's point: agent text AFTER the last tool row must land —
// neither impl may drop the trailing message
if (legacy.messageChars < postToolChars) {
  problems.push(
    `post-tool agent text dropped by legacy: chars=${legacy.messageChars} < ${postToolChars}`
  );
}
if (acp.messageChars < postToolChars) {
  problems.push(
    `post-tool agent text dropped by acp: chars=${acp.messageChars} < ${postToolChars}`
  );
}
// both impls get the same prompt row — same first item
eq('prompts', legacy.prompts, acp.prompts);

if (problems.length > 0) {
  console.log(`FAIL: ${problems.join('; ')}`);
  process.exit(1);
}
console.log('OK — coverage agrees');
