import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/testkit.ts'],
  format: ['esm'],
  dts: true,
})
