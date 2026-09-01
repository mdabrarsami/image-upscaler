import { defineConfig, devices } from '@playwright/test';

/**
 * Browser test configuration.
 *
 * Chromium is the only project enabled by default because it is the only
 * engine that ships WebGPU today, and because CI images reliably have it.
 * Firefox and WebKit are defined and can be enabled with `--project`; the
 * suite is written so every test either works on all three or skips itself
 * with a stated reason.
 */
const PORT = 4173;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  // Model downloads and 8x runs on 4K images are slow by nature.
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  retries: process.env.CI ? 1 : 0,
  workers: 1,

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            // WebGPU is behind a flag on Linux CI images and needs a real or
            // software adapter to be present at all.
            '--enable-unsafe-webgpu',
            '--enable-features=Vulkan',
            '--use-angle=swiftshader',
            '--use-gl=angle',
          ],
        },
      },
    },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],

  webServer: {
    command: 'node tests/e2e/server.mjs',
    // A concrete file, not the origin root: there is no index.html at the repo
    // root, and Playwright treats a 404 as "not ready yet".
    url: `${BASE_URL}/tests/e2e/pages/script-tag.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
