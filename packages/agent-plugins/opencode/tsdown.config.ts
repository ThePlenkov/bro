import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/opencode.ts', 'src/tui.tsx', 'src/rpc.ts'],
  format: ['esm'],
  dts: true,
  fixedExtension: false,
});
