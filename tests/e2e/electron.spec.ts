import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test } from '@playwright/test';

/**
 * Electron.
 *
 * Electron is not a dependency of this repo. It is a ~150 MB download that only
 * this one file needs, and a broken or partial install would break `npm
 * install` for everyone else. So the test looks for it and skips with a stated
 * reason when it is absent:
 *
 *     npm i -D electron
 *     npx playwright test tests/e2e/electron.spec.ts --project=chromium
 *
 * What it verifies is narrow and worth verifying: the *same* prebuilt ESM
 * bundle a web page loads also runs unmodified in a sandboxed Electron
 * renderer, with no Node integration and no Electron-specific code path.
 */

const require = createRequire(import.meta.url);
const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../examples/electron');

function electronBinary(): string | null {
  try {
    const path = require('electron') as unknown;
    if (typeof path === 'string' && existsSync(path)) return path;
    return null;
  } catch {
    return null;
  }
}

test.describe('Electron renderer', () => {
  test('runs the unmodified core package and produces a real image', async () => {
    const binary = electronBinary();
    test.skip(
      binary === null,
      'Electron is not installed. Run `npm i -D electron` to enable this test.',
    );

    test.setTimeout(120_000);

    const app = await electron.launch({
      args: [APP_DIR],
      executablePath: binary ?? undefined,
      env: { ...process.env, UPSCALER_ELECTRON_HEADLESS: '1' },
    });

    try {
      const window = await app.firstWindow();
      await window.waitForFunction(() => '__upscalerResult' in window, undefined, {
        timeout: 90_000,
      });

      const payload = await window.evaluate(
        () => (window as unknown as { __upscalerResult: Record<string, unknown> }).__upscalerResult,
      );

      expect(payload.ok, String(payload.message ?? '')).toBe(true);
      // A renderer is a browser, and the library must recognise it as one
      // rather than reaching for a Node path.
      expect(payload.environment).toBe('browser');
      expect(payload.width).toBe(384);
      expect(payload.height).toBe(384);
      expect(payload.engine).toBe('classical');
      expect(payload.format).toBe('png');
      expect(payload.bytes as number).toBeGreaterThan(1000);

      const capabilities = payload.capabilities as Record<string, boolean>;
      expect(capabilities.wasm).toBe(true);
      expect(capabilities.workers).toBe(true);
    } finally {
      await app.close();
    }
  });
});
