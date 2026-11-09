import { expect, test } from '@playwright/test';

/**
 * The vanilla demo page.
 *
 * Separate from `distribution.spec.ts`, which drives a minimal harness. This
 * one loads the actual demo a reader is pointed at, so a broken example is
 * caught here rather than by the first person who tries it.
 */

const DEMO = '/examples/vanilla/index.html';

test('loads from a plain script tag with no console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.goto(DEMO);

  await expect(page.getByRole('heading', { name: 'Image Upscaler' })).toBeVisible();
  // Capabilities are probed on load, so this proves the bundle evaluated.
  await expect(page.locator('#capabilities')).not.toHaveText(/Detecting/);
  await expect(page.locator('#version')).toContainText('@mdabrarsami/image-upscaler v');
  // The model list is rendered from the real catalogue.
  await expect(page.locator('#models li')).toHaveCount(2);

  expect(errors, errors.join(' | ')).toEqual([]);
});

test('generates a sample, upscales it, and shows the comparison', async ({ page }) => {
  await page.goto(DEMO);

  await page.locator('#sample').click();
  await expect(page.locator('#run')).toBeEnabled();

  await page.locator('#scale').selectOption('4');
  await page.locator('#engine').selectOption('classical');
  await page.locator('#run').click();

  await expect(page.locator('#stats')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#stats')).toContainText('640 x 640');
  await expect(page.locator('#stats')).toContainText('classical');

  // The comparison slider is populated with a real result.
  await expect(page.locator('#compare')).toBeVisible();
  const natural = await page.locator('#afterImg').evaluate((el) => ({
    width: (el as HTMLImageElement).naturalWidth,
    height: (el as HTMLImageElement).naturalHeight,
  }));
  expect(natural).toEqual({ width: 640, height: 640 });

  await expect(page.locator('#download')).toBeEnabled();
});

test('the fine-tuning sliders reflect the selected mode', async ({ page }) => {
  await page.goto(DEMO);

  const sharpening = page.locator('#sharpening');
  await page.locator('#mode').selectOption('natural');
  const natural = await sharpening.inputValue();

  await page.locator('#mode').selectOption('detail');
  const detail = await sharpening.inputValue();

  // Reading the real presets, not hard-coded numbers in the demo.
  expect(Number(detail)).toBeGreaterThan(Number(natural));
});

test('cancel stops a run without leaving an error', async ({ page }) => {
  await page.goto(DEMO);

  await page.locator('#sample').click();
  await page.locator('#scale').selectOption('8');
  await page.locator('#engine').selectOption('classical');
  await page.locator('#run').click();

  await expect(page.locator('#cancelRun')).toBeEnabled();
  await page.locator('#cancelRun').click();

  await expect(page.locator('#progressText')).toHaveText('Cancelled.', { timeout: 30_000 });
  await expect(page.locator('#error')).toBeHidden();
});

test('asking for AI without a model explains what to do', async ({ page }) => {
  await page.goto(DEMO);

  await page.locator('#sample').click();
  await page.locator('#engine').selectOption('ai');
  await page.locator('#run').click();

  const error = page.locator('#error');
  await expect(error).toBeVisible({ timeout: 30_000 });
  // The demo translates the error code into an instruction rather than
  // showing the raw code.
  await expect(error).toContainText('needs an AI model');
});
