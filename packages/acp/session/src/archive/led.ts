/** Herdr's reportable pane states — `done` is not reportable, `idle`
 *  renders the native `✓` on unviewed panes. */
export type LedState = 'working' | 'blocked' | 'idle' | 'unknown';

/** The semantic verdict a pane self-reports — always a report: the
 *  pane is a dashboard, so `stopped` reads `idle` and release is
 *  reserved for the process's own exit. Generic LED vocabulary —
 *  archive verdicts produce it, bro-side reporters translate it. */
export interface PaneLed {
  state: LedState;
  message?: string;
}
