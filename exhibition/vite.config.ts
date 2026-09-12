import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
export default defineConfig({
  root: path.resolve('exhibition'), publicDir: path.resolve('public'),
  plugins: [react()],
  build: { outDir: path.resolve('.exhibition-build/client'), emptyOutDir: true, reportCompressedSize: false },
});
