/** The journal → item vocabulary — time heads and origin labels.
 *  Self-contained: no imports, no framework. Moved out of the old
 *  tui `view.ts` because the MODEL consumes it (items carry `──
 *  HH:MM · by ──` heads and `by` provenance labels), and model
 *  cannot read view under the package's layer direction. */

/** `at` → the `HH:MM` separator stamp (local time — the reader's
 *  clock, not the journal's UTC). Missing stamps render nothing. */
export const hhmm = (at: string | undefined): string => {
  if (at === undefined) return '';
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A footer/board-short timestamp: today's stamp is `HH:MM`, an older
 *  same-year one `02 Nov 14:36`, and a cross-year one `02 Nov 2025
 *  14:36` — "idle since" reads at a glance either way. A malformed
 *  stamp renders '' rather than `NaN:NaN` nonsense. */
export const fmtWhen = (ts: string | number): string => {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === now.toDateString()) return hm;
  const yr = d.getFullYear() === now.getFullYear() ? '' : `${d.getFullYear()} `;
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${yr}${hm}`;
};

/** `at` → the day-change label — `2 Mar` (British, no year: multi-day
 *  replays rarely cross one, and the head carries the minute too). */
export const dayLabel = (at: string): string => {
  const d = new Date(at);
  return `${d.getDate()} ${MONTHS[d.getMonth()] ?? '?'}`;
};

/** The journal's `by` → the head's origin label. The session's own
 *  agent (`acp provider 'X'`) unwraps to its name — the pane's most
 *  important identity; internal calls (`conductor:t`, `provider:kilo`,
 *  `acp-transport:x`) keep their raw label so internal work never
 *  masquerades as the agent's. */
export const headBy = (by: string | undefined): string | undefined => {
  if (by === undefined || by === '') return undefined;
  return /^acp provider '([^']+)'$/.exec(by)?.[1] ?? by;
};

/** The session's own agent — the acp-worker journals its turns as
 *  `acp` or `acp provider 'X'` (acp-worker.ts's `by`). Every other
 *  provenance (`conductor:*`, `provider:*`, `acp-transport:*`,
 *  `delegate`, `acp proxy`) is orchestrator machinery — a run of
 *  those micro-turns collapses into one `▸ N internal calls` row
 *  instead of one row per one-token reply (addendum 27). */
const AGENT_BY = /^acp(?: provider '[^']+')?$/;
export const isInternalBy = (by: string | undefined): boolean =>
  by !== undefined && by !== '' && !AGENT_BY.test(by);

/** The journal's `by` → a short origin label for compact rows —
 *  `acp provider 'X'`→X, `provider:X`→X, `conductor:X`→X, anything
 *  else verbatim. Undefined input stays undefined. */
export const shortBy = (by: string | undefined): string | undefined => {
  if (by === undefined || by === '') return undefined;
  const m =
    /^acp provider '([^']+)'$/.exec(by) ??
    /^provider:(.+)$/.exec(by) ??
    /^conductor:(.+)$/.exec(by);
  return m?.[1] ?? by;
};

/** `68587` → `69k`, `262144` → `262k`, `1_500_000` → `1.5M`,
 *  `512` → `512` — the usage line's compact count (SI thousands,
 *  matching the acp ctx fold's /1000 convention). */
const fmtK = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
    : n >= 1_000
      ? `${Math.round(n / 1_000)}k`
      : String(n);

/** `68587/262144` → `69k/262k · 26%` — the context fill as a
 *  readable count plus its percentage of the window. The pct
 *  floors: `999/1k` is `99%`, not `100%` (not full); a nonzero
 *  fill under one percent is `<1%`, not `0%` (not empty). A
 *  zero/unknown size drops the percentage rather than printing
 *  `∞%`/lying. */
export const fmtUsage = (used: number, size: number): string => {
  if (size <= 0) return `${fmtK(used)}/${fmtK(size)}`;
  const pct = Math.floor((used / size) * 100);
  return `${fmtK(used)}/${fmtK(size)} · ${pct === 0 && used > 0 ? '<1' : pct}%`;
};

/** The separator layer — time as ROWS, not a column (addendum 25).
 *  `start()` records the turn's origin; `tick(ts)` runs before every
 *  item birth and returns the separator lines to emit first. Heads
 *  are keyed on (minute, by): a micro-turn storm in one minute under
 *  one origin collapses to a single `── HH:MM · by ──`, a same-minute
 *  origin change re-heads, a mid-turn minute change re-heads with the
 *  new time (long turns re-anchor their origin on scroll), a day
 *  change emits `── D Mmm ──` first. Laziness is the point: a turn
 *  that births no visible item earns no head. */
export class TimeGutter {
  private day: string | undefined;
  private min: string | undefined;
  private by: string | undefined;
  private curBy: string | undefined;
  /** A turn (or journaled prompt) started — the next birth heads
   *  under this origin. A by-less start clears it: orphan items head
   *  bare rather than inherit a dead turn's origin. */
  start(by: string | undefined): void {
    this.curBy = headBy(by);
  }
  /** Separator lines owed before an item stamped `ts` — [] when the
   *  (minute, by) group already holds. */
  tick(ts: string | undefined): string[] {
    if (ts === undefined) return [];
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return [];
    const out: string[] = [];
    // the day key is LOCAL — the same clock hhmm/dayLabel print, so
    // a 23:59Z event already "tomorrow" for the reader lands under
    // the new day's marker, never under yesterday's
    const day = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (day !== this.day) {
      this.day = day;
      this.min = undefined;
      this.by = undefined;
      out.push(`── ${dayLabel(ts)} ──`);
    }
    const m = hhmm(ts);
    if (m !== this.min || this.curBy !== this.by) {
      this.min = m;
      this.by = this.curBy;
      out.push(this.curBy !== undefined ? `── ${m} · ${this.curBy} ──` : `── ${m} ──`);
    }
    return out;
  }
}
