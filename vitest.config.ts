import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The pure numeric core runs happily in Node. Anything that needs a real
    // canvas, GPU, Worker or IndexedDB is covered by the Playwright suite
    // instead of a DOM shim, because a shim would test the shim.
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/image-upscaler/src/**/*.ts'],
      exclude: [
        'packages/image-upscaler/src/**/*.wgsl.ts',
        'packages/image-upscaler/src/workers/worker.ts',
      ],
      reporter: ['text', 'html'],
    },
    testTimeout: 30_000,
  },
});
