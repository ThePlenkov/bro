// @broject/herdr-kit — the bro-side herdr bridge kit. Internal modules
// keep their seams: client/ is the only place herdr is exec'd;
// fleet/ is the status-doc contract; lines/ is the line-mode pane
// lifecycle; views/ is the convergence decision layer. The index is
// the package's one public surface.

/** LED vocabulary — re-exported at the root (tsdown's dts bundler
 *  drops re-exported external types through nested modules). */
export type { LedState, PaneLed } from '@broject/acp-session';
export * from './client/index.ts';
export * from './fleet/index.ts';
