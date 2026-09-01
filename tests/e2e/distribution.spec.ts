import { expect, test } from '@playwright/test';

/**
 * The distribution promises.
 *
 * Each of these corresponds to a line in the README that would otherwise be
 * taken on trust: the script tag really installs a global, the ESM bundle
 * really imports without a bundler, and both really produce an image.
 */

test.describe('script tag', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/tests/e2e/pages/script-tag.html');
  });

  test('installs a constructible ImageUpscaler global', async ({ page }) => {
    const info = await page.evaluate(() => {
      const global = (window as unknown as { ImageUpscaler: unknown }).ImageUpscaler;
      const Ctor = global as new () => object;
      const instance = new Ctor();
      return {
        type: typeof global,
        constructible: instance instanceof Ctor,
        hasUpscale: typeof (instance as { upscale?: unknown }).upscale === 'function',
        hasModels: typeof (instance as { models?: unknown }).models === 'object',
        version: (global as { VERSION?: string }).VERSION,
        statics: [
          'detectCapabilities',
          'UpscalerError',
          'ClassicalUpscaler',
          'ModelRegistry',
          'getPreset',
          'resample',
          'isCancellation',
        ].filter((key) => (global as Record<string, unknown>)[key] !== undefined),
      };
    });

    expect(info.type).toBe('function');
    expect(info.constructible).toBe(true);
    expect(info.hasUpscale).toBe(true);
    expect(info.hasModels).toBe(true);
    expect(info.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(info.statics).toHaveLength(7);
  });

  test('needs no module system, npm, or bundler at runtime', async ({ page }) => {
    const clean = await page.evaluate(() => ({
      // A classic script has no module scope; if the bundle leaked one of
      // these it would not work from a CDN.
      noRequire: typeof (window as unknown as { require?: unknown }).require === 'undefined',
      noExports: typeof (window as unknown as { exports?: unknown }).exports === 'undefined',
      noModule: typeof (window as unknown as { module?: unknown }).module === 'undefined',
      noProcess: typeof (window as unknown as { process?: unknown }).process === 'undefined',
    }));
    expect(clean).toEqual({
      noRequire: true,
      noExports: true,
      noModule: true,
      noProcess: true,
    });
  });

  test('upscales a real image and returns a real PNG', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const Ctor = (window as never as { ImageUpscaler: new (c?: object) => never })
        .ImageUpscaler;
      const harness = (window as never as { harness: { makeFile(size?: number): Promise<File> } })
        .harness;

      const file = await harness.makeFile(64);
      const upscaler = new Ctor({ useWorker: false }) as {
        upscale(input: File, options: object): Promise<{
          blob: Blob;
          width: number;
          height: number;
          originalWidth: number;
          originalHeight: number;
          scale: number;
          engine: string;
          runtime: string;
          format: string;
          processingTime: number;
          arrayBuffer(): Promise<ArrayBuffer>;
        }>;
        dispose(): Promise<void>;
      };

      const out = await upscaler.upscale(file, { scale: 4, engine: 'classical' });
      const bytes = new Uint8Array((await out.arrayBuffer()).slice(0, 8));
      await upscaler.dispose();

      return {
        width: out.width,
        height: out.height,
        originalWidth: out.originalWidth,
        originalHeight: out.originalHeight,
        scale: out.scale,
        engine: out.engine,
        runtime: out.runtime,
        format: out.format,
        blobType: out.blob.type,
        blobSize: out.blob.size,
        processingTime: out.processingTime,
        magic: Array.from(bytes),
      };
    });

    expect(result.width).toBe(256);
    expect(result.height).toBe(256);
    expect(result.originalWidth).toBe(64);
    expect(result.scale).toBe(4);
    expect(result.engine).toBe('classical');
    expect(result.format).toBe('png');
    expect(result.blobType).toBe('image/png');
    // A real encoded image, not an empty or placeholder blob.
    expect(result.blobSize).toBeGreaterThan(1000);
    expect(result.processingTime).toBeGreaterThan(0);
    // PNG signature.
    expect(result.magic).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  test('the decoded result is actually larger and not a rescaled copy', async ({ page }) => {
    // Guards against the laziest possible fake: returning the input, or
    // letting CSS do the enlarging.
    const analysis = await page.evaluate(async () => {
      const Ctor = (window as never as { ImageUpscaler: new (c?: object) => never })
        .ImageUpscaler;
      const harness = (
        window as never as {
          harness: {
            makeFile(size?: number): Promise<File>;
            pixels(blob: Blob): Promise<{ width: number; height: number; data: number[] }>;
          };
        }
      ).harness;

      const file = await harness.makeFile(48);
      const upscaler = new Ctor({ useWorker: false }) as {
        upscale(i: File, o: object): Promise<{ blob: Blob }>;
        dispose(): Promise<void>;
      };
      const out = await upscaler.upscale(file, { scale: 2, engine: 'classical' });
      const after = await harness.pixels(out.blob);
      const before = await harness.pixels(file);
      await upscaler.dispose();

      // Count distinct luma values as a crude measure of tonal richness: a
      // nearest-neighbour or CSS enlargement cannot add any.
      const distinct = (p: { data: number[] }): number => {
        const seen = new Set<number>();
        for (let i = 0; i < p.data.length; i += 4) {
          seen.add((p.data[i] * 0.2126 + p.data[i + 1] * 0.7152 + p.data[i + 2] * 0.0722) | 0);
        }
        return seen.size;
      };

      return {
        beforeSize: [before.width, before.height],
        afterSize: [after.width, after.height],
        beforeDistinct: distinct(before),
        afterDistinct: distinct(after),
        beforeBytes: file.size,
        afterBytes: out.blob.size,
      };
    });

    expect(analysis.beforeSize).toEqual([48, 48]);
    expect(analysis.afterSize).toEqual([96, 96]);
    // Interpolation genuinely produces intermediate tones.
    expect(analysis.afterDistinct).toBeGreaterThan(analysis.beforeDistinct);
    expect(analysis.afterBytes).not.toBe(analysis.beforeBytes);
  });

  test('reports capabilities that agree with the browser', async ({ page }) => {
    const caps = await page.evaluate(async () => {
      const global = (window as never as {
        ImageUpscaler: { detectCapabilities(): Promise<Record<string, unknown>> };
      }).ImageUpscaler;
      const detected = await global.detectCapabilities();
      return {
        detected,
        actual: {
          workers: typeof Worker !== 'undefined',
          wasm: typeof WebAssembly !== 'undefined',
          offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
          indexedDB: typeof indexedDB !== 'undefined',
          gpuInNavigator: 'gpu' in navigator,
        },
      };
    });

    expect(caps.detected.workers).toBe(caps.actual.workers);
    expect(caps.detected.wasm).toBe(caps.actual.wasm);
    expect(caps.detected.offscreenCanvas).toBe(caps.actual.offscreenCanvas);
    expect(caps.detected.indexedDB).toBe(caps.actual.indexedDB);
    // WebGPU is probed, not sniffed, so it may be false even when the property
    // exists - but it must never be true when the property does not.
    if (!caps.actual.gpuInNavigator) expect(caps.detected.webGPU).toBe(false);
    expect(Array.isArray(caps.detected.encodableFormats)).toBe(true);
    expect(caps.detected.encodableFormats as string[]).toContain('png');
    expect(caps.detected.estimatedMemory as number).toBeGreaterThan(0);
  });
});

test.describe('ESM bundle', () => {
  test('imports without a bundler and exposes the documented API', async ({ page }) => {
    await page.goto('/tests/e2e/pages/esm.html');
    await page.waitForFunction(() => (window as never as { esmReady?: boolean }).esmReady === true);

    const shape = await page.evaluate(() => {
      const esm = (window as never as { esm: Record<string, unknown> }).esm;
      return {
        keys: Object.keys(esm).sort(),
        upscalerIsFunction: typeof esm.ImageUpscaler === 'function',
        resampleIsFunction: typeof esm.resample === 'function',
        version: esm.VERSION,
      };
    });

    expect(shape.upscalerIsFunction).toBe(true);
    expect(shape.resampleIsFunction).toBe(true);
    expect(shape.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(shape.keys).toContain('detectCapabilities');
    expect(shape.keys).toContain('UpscalerError');
  });

  test('runs the whole pipeline through the imported module', async ({ page }) => {
    await page.goto('/tests/e2e/pages/esm.html');
    await page.waitForFunction(() => (window as never as { esmReady?: boolean }).esmReady === true);

    const result = await page.evaluate(async () => {
      const esm = (window as never as {
        esm: { ImageUpscaler: new (c?: object) => never };
      }).esm;

      const canvas = document.createElement('canvas');
      canvas.width = 40;
      canvas.height = 30;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#ed7532';
      ctx.fillRect(0, 0, 40, 30);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(10, 10, 5, 5);

      const upscaler = new esm.ImageUpscaler({ useWorker: false }) as {
        upscale(i: HTMLCanvasElement, o: object): Promise<{
          width: number;
          height: number;
          format: string;
          blob: Blob;
        }>;
        dispose(): Promise<void>;
      };
      // A canvas input, to cover an input type the script-tag test does not.
      const out = await upscaler.upscale(canvas, { scale: 2, engine: 'classical' });
      await upscaler.dispose();
      return { width: out.width, height: out.height, format: out.format, size: out.blob.size };
    });

    expect(result.width).toBe(80);
    expect(result.height).toBe(60);
    expect(result.size).toBeGreaterThan(100);
  });

  test('lower-level exports work standalone, so tree-shaking is worth doing', async ({ page }) => {
    await page.goto('/tests/e2e/pages/esm.html');
    await page.waitForFunction(() => (window as never as { esmReady?: boolean }).esmReady === true);

    const check = await page.evaluate(() => {
      const esm = (
        window as never as {
          esm: {
            createSurface(w: number, h: number): { data: Float32Array; width: number; height: number };
            resample(s: unknown, w: number, h: number, o?: unknown): { width: number; height: number; data: Float32Array };
            getKernel(name: string): { name: string; support: number };
          };
        }
      ).esm;

      const surface = esm.createSurface(8, 8);
      for (let i = 0; i < surface.data.length; i += 4) {
        surface.data[i] = 0.5;
        surface.data[i + 1] = 0.25;
        surface.data[i + 2] = 0.75;
        surface.data[i + 3] = 1;
      }
      const out = esm.resample(surface, 16, 16, { kernel: esm.getKernel('lanczos3') });
      return {
        size: [out.width, out.height],
        firstPixel: [out.data[0], out.data[1], out.data[2], out.data[3]].map(
          (v) => Math.round(v * 1000) / 1000,
        ),
        kernelSupport: esm.getKernel('lanczos3').support,
      };
    });

    expect(check.size).toEqual([16, 16]);
    // A constant input must come out constant.
    expect(check.firstPixel).toEqual([0.5, 0.25, 0.75, 1]);
    expect(check.kernelSupport).toBe(3);
  });
});
