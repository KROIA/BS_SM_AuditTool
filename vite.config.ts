import { svelte } from '@sveltejs/vite-plugin-svelte';
import fs from 'node:fs';
import { defineConfig } from 'vite';

// The screens only. The window process and the engine are compiled by tsc (tsconfig.node.json).
export default defineConfig({
  root: 'src/ui',
  base: './', // the window loads the page from a file, so every path must be relative
  plugins: [svelte()],
  // The version of package.json, for the Info panel.
  define: { __APP_VERSION__: JSON.stringify(JSON.parse(fs.readFileSync('package.json', 'utf8')).version) },
  build: { outDir: '../../dist/ui', emptyOutDir: true },
});
