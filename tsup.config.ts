import { defineConfig } from 'tsup'

// Build de production : un seul fichier JS, le paquet @gd/shared (sources TS) est intégré au bundle.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  noExternal: ['@gd/shared'],
})
