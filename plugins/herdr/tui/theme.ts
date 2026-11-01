/**
 * The session pane's theme (spec bro-q2edc) — semantic tokens, not
 * raw hex: every color the tree paints names a ROLE. One palette,
 * and the `SyntaxStyle` derived from it in `app.tsx` (Bun-only —
 * this file stays pure so `view.ts`/`state.ts` import it from the
 * Node tests).
 *
 * The palette is opencode's, captured live from a real pane
 * (`/tmp/opencode-view.ansi`, addendum 13): base `#0a0a0a`, blocks
 * `#141414`, the peach `┃` bar, amber `+ Thought` rows, cyan
 * `↳`/link accents. `error` is not in the capture slice — it keeps
 * opencode's standard red.
 */
export const theme = {
  /** The pane's ground — every row sits on this. */
  base: '#0a0a0a',
  /** Block surfaces — `┃` cards, the header bar, selection wash. */
  surface: '#141414',
  /** Default text. */
  text: '#ffffff',
  /** Emphasis — block titles, the question line, `↑↓` hints. */
  emph: '#eeeeee',
  /** Receded — secondary text, `·` tails, option bodies, the footer. */
  muted: '#808080',
  /** The peach bar — `┃` left edge and the caller-prompt accent. */
  peach: '#fab283',
  /** `+ Thought` rows (their dark amber). */
  amber: '#97682c',
  /** `↳` subagent labels and links (underlined). */
  cyan: '#56b6c2',
  /** Status labels — their `Build · model · t · tok/s` blue. */
  info: '#5c9cf5',
  /** Done/healthy — completed tool edges, idle LED. */
  success: '#7fd88f',
  /** Careful — inline warnings, permission asks, live-tool accents. */
  warning: '#f5a742',
  /** Broken — failed tools, failed turns, blocked LED. */
  error: '#e06c75',
  /** Selection accent — the pane's own voice (their accent is the
   *  peach; selection needs a distinct read, their blue). */
  accent: '#5c9cf5',
  /** Card border at rest (unselected) — barely-there on the base. */
  border: '#1f1f1f',
  /** The scroll thumb — a dim notch floating on the base, not a
   *  bright rail. */
  scrollbar: '#4a4a4d',
} as const;

export type Theme = typeof theme;

/** The LED chip's color by state — the pane's one glanceable
 *  health read, same contract the LED report feeds. */
export function ledColor(state: string | undefined): string {
  switch (state) {
    case 'working':
      return theme.info;
    case 'idle':
      return theme.success;
    case 'blocked':
    case 'error':
      return theme.error;
    default:
      return theme.muted;
  }
}
