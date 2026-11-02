/** The archive path contract — one derivation for every reader and
 *  the writer. Until now each side re-derived
 *  `<common>/bro/agents/<agentId>.events.jsonl` (and the sibling
 *  `.prompt.md`) by inline join/regex; five sites agreeing by
 *  convention is how contracts rot — the shapes live here once. */
import { join } from 'node:path';

/** The session-owning agent's durable journal —
 *  `<common>/bro/agents/<agentId>.events.jsonl`. */
export const eventsFile = (common: string, agentId: string): string =>
  join(common, 'bro', 'agents', `${agentId}.events.jsonl`);

/** The proxy-scope journal — `<common>/bro/proxy/acp-<sid>-p<pid>
 *  .events.jsonl`. `-p<pid>` keeps two concurrent proxy runs of the
 *  same session id (a reconnect, a duplicated client) from mixing
 *  rows in one archive. */
export const proxyEventsFile = (common: string, sessionId: string, pid: number): string =>
  join(common, 'bro', 'proxy', `acp-${sessionId.replace(/[^\w.-]/g, '_')}-p${pid}.events.jsonl`);

/** The sibling `<agentId>.prompt.md` bro writes at spawn — the archive
 *  journals no user-side rows for pre-prompt-journal sessions, so the
 *  file is the replay seed's fallback. Derived off the events path. */
export const promptFile = (eventsPath: string): string =>
  eventsPath.replace(/\.events\.jsonl$/, '.prompt.md');

/** The log stem — an events path minus its extension (the rendered
 *  `<agentId>.log` sibling hangs off the same stem). */
export const logStem = (eventsPath: string): string => eventsPath.replace(/\.events\.jsonl$/, '');
