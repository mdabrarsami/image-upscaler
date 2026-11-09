import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm', 'cjs'],
  target: 'es2022',
  platform: 'browser',
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  // Both are peers. Inlining React would break its single-instance rule, and
  // inlining the core would duplicate every cache the upscaler exists to hold.
  external: ['react', '@mdabrarsami/image-upscaler'],
});
