import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/testkit.ts'],
  format: ['esm'],
  // @broject/acp-* are private workspace packages — bundle them so the
  // published dist carries no unpublishable import, in code AND in
  // types (deps.dts.alwaysBundle inlines them into the .d.ts). @broject/core
  // stays external: it is published and shared-state.
  deps: { dts: { alwaysBundle: [/^@broject\/acp-/] } },
  fixedExtension: false,
  noExternal: [/^@broject\/acp-/],
});
