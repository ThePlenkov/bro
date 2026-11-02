// @broject/acp-session — the reusable ACP session package: wire decode,
// the archive contract + tail pump, the session model, and the
// renderer-independent segment/card view language. Internal layering is
// enforced mechanically by src/import-graph.test.ts:
//   wire ← archive ← model ← view
// The index is the package's one public surface; internal modules are
// reachable only through it.

export * from './archive/index.ts';
export * from './wire/index.ts';
