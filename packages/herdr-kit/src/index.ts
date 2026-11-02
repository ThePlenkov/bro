// @broject/herdr-kit — the bro-side herdr bridge kit. Internal modules
// keep their seams: client/ is the only place herdr is exec'd;
// fleet/ is the status-doc contract; lines/ is the line-mode pane
// lifecycle; views/ is the convergence decision layer. The index is
// the package's one public surface.
export * from './client/index.ts';
