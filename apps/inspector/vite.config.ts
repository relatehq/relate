import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base: the CLI (or a future host) mounts the shell at any path.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
    // ELK is one large self-contained worker chunk by design.
    chunkSizeWarningLimit: 1600,
  },
  worker: { format: 'es' },
  server: {
    port: 5173,
    strictPort: false,
  },
});
