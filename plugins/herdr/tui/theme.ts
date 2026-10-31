/**
 * The session pane's theme (spec bro-q2edc) — semantic tokens, not
 * raw hex: every color the tree paints names a ROLE, the way
 * opencode's theme context does. One palette, and the `SyntaxStyle`
 * derived from it in `app.tsx` (Bun-only — this file stays pure so
 * `view.ts`/`state.ts` import it from the Node tests).
 *
 * The palette itself is Tokyo Night — the pane sits among the
 * fleet's other surfaces and borrows their dusk accent.
 */
export const theme = {
  /** The pane's own voice — selection accents, live LED. */
  accent: '#7aa2f7',
  /** Done/healthy — completed tool edges, idle LED. */
  success: '#9ece6a',
  /** Broken — failed tools, failed turns, blocked LED. */
  error: '#f7768e',
  /** Careful — permission asks, live-tool accents. */
  warning: '#e0af68',
  /** Receded — dim one-liners, kind/arg spans, the footer. */
  muted: '#565f89',
  /** Card surfaces — the selected card's bg, card borders at rest. */
  surface: '#1a1b26',
  /** Card border at rest (unselected). */
  border: '#3b4261',
  /** Agent speech. */
  text: '#c0caf5',
} as const;

export type Theme = typeof theme;

/** The LED chip's color by state — the pane's one glanceable
 *  health read, same contract the LED report feeds. */
export function ledColor(state: string | undefined): string {
  switch (state) {
    case 'working':
      return theme.accent;
    case 'idle':
      return theme.success;
    case 'blocked':
    case 'error':
      return theme.error;
    default:
      return theme.muted;
  }
}
