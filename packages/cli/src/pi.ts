// bro-adapter — ownership sentinel for `bro plugins` (isBroAdapter); do not remove
/**
 * The pi adapter's published entry point.
 *
 * The adapter itself lives in `src/adapter/pi.ts` — a thin binding over
 * the shared core in `src/adapter/core.ts` and the shared driver in
 * `src/adapter/host.ts`. This file is only the module tsdown bundles
 * into `dist/pi.js` and the `"./pi"` package export.
 *
 * Why a separate entry: the shipped plugin has to be ONE standalone
 * file (the host loads it with no node_modules to resolve against), and
 * the bundler needs a single entry point per adapter.
 */
export { default, adapter } from './adapter/pi.ts'
