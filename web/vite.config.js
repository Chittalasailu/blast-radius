import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname);

export default defineConfig({
  root,
  plugins: [react()],
  build: {
    outDir: path.join(root, 'dist'),
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    proxy: { '/api': 'http://127.0.0.1:4173' },
  },
});
