import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Built to a subdirectory of the repo-wide static server so the e2e suite can
  // load the production bundle at a stable path.
  base: '/examples/react/dist/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // No minification of the demo itself: when a test fails, the stack trace
    // should point at readable code.
    minify: false,
    sourcemap: true,
  },
  optimizeDeps: {
    // The runtime is loaded lazily and pulls in .wasm; pre-bundling it fights
    // that and produces a broken dev server.
    exclude: ['onnxruntime-web'],
  },
});
