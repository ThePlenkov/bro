/**
 * The pane implementation seam (spec bro-q2edc, "Phase 2 — the
 * seam"). The shell (`main.ts`) speaks only this contract: archive
 * rows in, model ops out, plus the LED verdict and the headless
 * dump. `model.ts` (`SessionModel`) is the `legacy` impl; the
 * vendored `acp-model` stack implements the same seam in `acp/`.
 * A third impl plugs in by registering here — nothing else moves.
 *
 * The seam's currency is the `Op` stream the pane's state fold
 * already consumes (`state.ts`), so `app.tsx`, the writer, and the
 * key bindings are impl-agnostic by construction. What differs per
 * impl is the item tree's SHAPE and the fold policy (`fold`) —
 * `legacy` keeps the COLLAPSE_AT heuristic, `acp` folds every
 * collapsible card (the vendored view-model's baseline).
 */
import type { PaneLed } from '../../../packages/cli/src/commands/fleet-state.ts';
import type { ArchiveRow } from '../../../packages/cli/src/commands/session-feed.ts';
import { copyItem, type Item, type Op, SessionModel } from './model.ts';

/** How the fold treats a freshly landed card body: `legacy` folds
 *  past COLLAPSE_AT lines, `folded` folds every body (vendored
 *  baseline — "too verbose" is the bug). */
export type FoldPolicy = 'legacy' | 'folded';

/** One renderer pipeline behind the seam: feed → model → items. */
export interface PaneImpl {
  /** Registry id — 'legacy' | 'acp'. */
  readonly name: string;
  /** The fold policy the shell's state fold honors. */
  readonly fold: FoldPolicy;
  /** One archive row into the impl's model. */
  feed(row: ArchiveRow): void;
  /** The replay boundary: everything fed so far was archive history;
   *  rows after this are the live tail. A no-op for impls without a
   *  replay/live distinction. */
  beginLive(): void;
  /** The ops produced since the last drain — the shell's queue. */
  drain(): Op[];
  /** The impl's latest LED verdict (same shape rowVerdict returns) —
   *  the shell mixes it with the worker floor via eventsVerdict. */
  readonly verdict: { led: PaneLed; mode: string } | undefined;
  /** The headless text projection — the `--dump` readout. */
  dump(): string[];
  /** The item's full raw text for clipboard copy — the impl's own
   *  line language, unclipped. Unset impls fall back to `item.text`. */
  copyText?(item: Item): string;
}

/** `SessionModel` is the seam's reference impl — zero delegation
 *  loss: the legacy path keeps driving its own ops directly. */
class LegacyImpl implements PaneImpl {
  readonly name = 'legacy';
  readonly fold: FoldPolicy = 'legacy';
  private readonly model = new SessionModel();
  feed(row: ArchiveRow): void {
    this.model.feed(row);
  }
  beginLive(): void {
    // the archive pump knows no replay/live split — every row is
    // observed tail, verdict rides the last row
  }
  drain(): Op[] {
    return this.model.drain();
  }
  get verdict(): { led: PaneLed; mode: string } | undefined {
    return this.model.verdict;
  }
  dump(): string[] {
    return this.model.dump();
  }
  copyText(item: Item): string {
    return copyItem(item);
  }
}

/** Impl factories — `acp` resolves lazily so Node-side tests (and
 *  the `--dump` path under plain bun without node_modules) never
 *  load `acp-model`. */
const IMPLS: Record<string, () => PaneImpl | Promise<PaneImpl>> = {
  legacy: () => new LegacyImpl(),
  acp: async () => new (await import('./acp/model.ts')).AcpImpl(),
};

/** The impl ids the registry knows — for usage text. */
export const IMPL_NAMES = Object.keys(IMPLS);

/** The `--impl <name>` argv value, or undefined. */
export function implArg(argv: readonly string[]): string | undefined {
  const i = argv.indexOf('--impl');
  if (i !== -1) return argv[i + 1];
  const eq = argv.find(a => a.startsWith('--impl='));
  return eq?.slice('--impl='.length);
}

/** Resolve the impl: `--impl` argv > `BRO_TUI_IMPL` env > 'legacy'.
 *  Unknown names fail loud — a typo must not silently run legacy. */
export async function pickImpl(
  name: string | undefined,
  env: Record<string, string | undefined> = process.env
): Promise<PaneImpl> {
  const pick = name ?? env.BRO_TUI_IMPL ?? 'legacy';
  const factory = IMPLS[pick];
  if (factory === undefined) {
    throw new Error(`unknown --impl '${pick}' (known: ${IMPL_NAMES.join(', ')})`);
  }
  return factory();
}
