import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/omp.ts'],
  format: ['esm'],
  dts: true,
  fixedExtension: false,
  noExternal: [/^@broject\//],
});
