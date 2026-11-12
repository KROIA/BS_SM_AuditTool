import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

// The screens only. The window process and the engine are compiled by tsc (tsconfig.node.json).
export default defineConfig({
  root: 'src/ui',
  base: './', // the window loads the page from a file, so every path must be relative
  plugins: [svelte()],
  build: { outDir: '../../dist/ui', emptyOutDir: true },
});
