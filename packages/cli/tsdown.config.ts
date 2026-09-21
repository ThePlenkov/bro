import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/plugin.ts'],
  format: ['esm'],
  dts: true,
  // Bundle workspace libs into the published CLI — consumers get one file.
  noExternal: [/^@bro\//],
})
