import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/kilo.ts'],
  format: ['esm'],
  dts: true,
  fixedExtension: false,
  noExternal: [/^@broject\//],
});
