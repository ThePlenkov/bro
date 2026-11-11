import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/core.ts', 'src/host.ts'],
  format: ['esm'],
  dts: true,
  fixedExtension: false,
});
