import { defineConfig } from 'vite';

// The Vite app lives in web/. Its publicDir (web/public) holds the generated
// graph.bin, meta.json and release.wasm produced by `pnpm export:graph`.
export default defineConfig({
  root: 'web',
  server: { open: true },
  build: { outDir: '../dist-web', emptyOutDir: true },
});
