import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/testkit.ts'],
  format: ['esm'],
  fixedExtension: false,
  // @broject/acp-* are private workspace packages — bundle them so the
  // published dist carries no unpublishable import, in code AND in
  // types (deps.alwaysBundle covers the .d.ts too). @broject/core
  // stays external: it is published and shared-state.
  dts: true,
  deps: { alwaysBundle: [/^@broject\/acp-/] },
});
