/** Bun-side preload seam — @opentui/solid ships no types for the
 *  plugin preload path; the dynamic import in serve.ts registers the
 *  JSX transform and returns nothing typeable. */
declare module '@opentui/solid/preload';
