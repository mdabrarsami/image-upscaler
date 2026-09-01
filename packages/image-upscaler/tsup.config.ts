import { defineConfig } from 'tsup';

/**
 * Four build targets, because they have genuinely different requirements:
 *
 *  - `index` / `ai`: ESM + CJS + declarations, externals left alone, for
 *    bundler consumers.
 *  - `worker`: ESM only, one file, no code splitting - a Worker URL has to
 *    resolve to something self-contained.
 *  - `browser`: IIFE, everything inlined, for `<script src>`.
 *  - `esm bundle`: a single pre-bundled ESM file for `<script type="module">`
 *    and CDN import, where there is no bundler to do the resolving.
 */
const shared = {
  target: 'es2022',
  platform: 'browser' as const,
  sourcemap: true,
  clean: false,
  treeshake: true,
};

export default defineConfig([
  {
    ...shared,
    entry: { index: 'src/index.ts', ai: 'src/ai.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    splitting: false,
    clean: true,
    // Optional peer: never inline it, never fail when it is absent.
    external: ['onnxruntime-web'],
  },
  {
    ...shared,
    entry: { worker: 'src/workers/worker.ts' },
    format: ['esm'],
    dts: true,
    splitting: false,
    external: ['onnxruntime-web'],
  },
  {
    ...shared,
    entry: { 'image-upscaler': 'src/browser.ts' },
    format: ['iife'],
    // tsup names IIFE output `*.global.js` by default; a CDN path reads better
    // without it, and the package.json `browser`/`unpkg` fields point here.
    outExtension: () => ({ js: '.js' }),
    dts: false,
    splitting: false,
    minify: false,
    // No externals: a script tag has no module resolver. The dynamic import of
    // onnxruntime-web stays dynamic, so classical-only pages never fetch it.
    noExternal: [/.*/],
    external: ['onnxruntime-web'],
  },
  {
    ...shared,
    entry: { 'image-upscaler.min': 'src/browser.ts' },
    format: ['iife'],
    outExtension: () => ({ js: '.js' }),
    dts: false,
    splitting: false,
    minify: true,
    noExternal: [/.*/],
    external: ['onnxruntime-web'],
  },
  {
    ...shared,
    entry: { 'image-upscaler.esm': 'src/index.ts' },
    format: ['esm'],
    dts: false,
    splitting: false,
    minify: true,
    noExternal: [/.*/],
    external: ['onnxruntime-web'],
  },
]);
