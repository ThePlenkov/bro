import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/pi.ts'],
  format: ['esm'],
  dts: true,
  fixedExtension: false,
  noExternal: [/^@broject\//],
});
