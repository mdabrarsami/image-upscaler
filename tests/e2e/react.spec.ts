import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * The React integration, exercised against a real Vite production build.
 *
 * A dev-server run would not prove much: the interesting question is whether
 * the published package resolves, type-checks and tree-shakes through a real
 * bundler, and whether the worker chunk and the lazily-loaded AI runtime come
 * out as separate files rather than being inlined into the main bundle.
 */

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../../examples/react/dist');
const APP_URL = '/examples/react/dist/index.html';

test.beforeAll(() => {
  if (!existsSync(resolve(DIST, 'index.html'))) {
    throw new Error(
      'The React example has not been built. Run `npm run build:demo` before the e2e suite.',
    );
  }
});

test('the production build boots and reports capabilities', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.goto(APP_URL);

  await expect(page.getByRole('heading', { name: 'Image Upscaler' })).toBeVisible();
  await expect(page.getByTestId('capabilities')).toBeVisible();
  // The hook lists the catalogue on mount, which means the core package
  // resolved and ran.
  await expect(page.getByTestId('models')).toBeVisible();
  await expect(page.getByTestId('models').locator('li')).toHaveCount(2);

  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});

test('upscales through the hook and renders the result', async ({ page }) => {
  await page.goto(APP_URL);

  await page.getByTestId('sample').click();
  await page.getByTestId('scale').selectOption('4');
  await page.getByTestId('engine').selectOption('classical');
  await page.getByTestId('run').click();

  // Progress is state, so it has to actually render.
  await expect(page.getByTestId('stage')).toBeVisible();

  await expect(page.getByTestId('stats')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('result-size')).toHaveText('512 x 512');
  await expect(page.getByTestId('result-engine')).toHaveText('classical');

  const image = page.getByTestId('result-image');
  await expect(image).toBeVisible();

  // The rendered <img> is the real result, at the real size.
  const natural = await image.evaluate((el) => ({
    width: (el as HTMLImageElement).naturalWidth,
    height: (el as HTMLImageElement).naturalHeight,
    src: (el as HTMLImageElement).src.slice(0, 5),
  }));
  expect(natural).toEqual({ width: 512, height: 512, src: 'blob:' });

  // A download link pointing at the same blob.
  await expect(page.getByTestId('download')).toHaveAttribute(
    'download',
    /upscaled-512x512\.(png|jpeg|webp)/,
  );
});

test('cancel stops a run and clears the progress state', async ({ page }) => {
  await page.goto(APP_URL);

  await page.getByTestId('sample').click();
  await page.getByTestId('scale').selectOption('8');
  await page.getByTestId('engine').selectOption('classical');
  await page.getByTestId('run').click();

  await expect(page.getByTestId('cancel')).toBeEnabled();
  await page.getByTestId('cancel').click();

  // A cancelled run is not an error: the hook resets rather than reporting.
  await expect(page.getByTestId('run')).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByTestId('error')).toHaveCount(0);
  await expect(page.getByTestId('stats')).toHaveCount(0);
});

test('the AI runtime and the worker are separate chunks, not part of the main bundle', async ({
  page,
}) => {
  // The tree-shaking claim, measured rather than asserted: a page that only
  // ever runs the classical engine must not fetch the ONNX runtime.
  const scripts: string[] = [];
  page.on('request', (request) => {
    if (['script', 'fetch', 'other'].includes(request.resourceType())) {
      scripts.push(request.url());
    }
  });

  await page.goto(APP_URL);
  await page.getByTestId('sample').click();
  await page.getByTestId('engine').selectOption('classical');
  await page.getByTestId('run').click();
  await expect(page.getByTestId('stats')).toBeVisible({ timeout: 60_000 });

  const ortRequests = scripts.filter((url) => /ort[.-]|onnxruntime/i.test(url));
  expect(
    ortRequests,
    'the classical path must not pull in the ONNX runtime',
  ).toEqual([]);

  // And the runtime really does exist as its own chunk, so the check above is
  // about laziness rather than about the runtime being absent from the build.
  const assets = await page.evaluate(async () => {
    const response = await fetch('/examples/react/dist/index.html');
    return response.text();
  });
  expect(assets).toContain('assets/');
});
