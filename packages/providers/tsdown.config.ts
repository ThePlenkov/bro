import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/testkit.ts'],
  format: ['esm'],
  // @broject/acp-* are private workspace packages — bundle them so the
  // published dist carries no unpublishable import, in code AND in
  // types (dts.resolve inlines them into the .d.ts). @broject/core
  // stays external: it is published and shared-state.
  dts: { resolve: [/^@broject\/acp-/] },
  noExternal: [/^@broject\/acp-/],
});
