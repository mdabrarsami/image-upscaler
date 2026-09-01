import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * AI, model management, offline operation and network privacy.
 *
 * These run against the real Real-ESRGAN ONNX export and really download it
 * once, because the claims being checked - that a 67 MB model caches, survives
 * a reload, works with the network cut, and that no image ever leaves the
 * device - cannot be checked against a stub.
 *
 * Ordered deliberately: the download test seeds the cache the later ones use.
 * `test.describe.serial` makes that dependency explicit rather than incidental.
 */

const AI_PAGE = '/tests/e2e/pages/ai.html';
const MODEL_ID = 'realesrgan-x2';
const MODEL_HOST = 'huggingface.co';

/** Typing for the harness page's globals. */
interface AiHarness {
  makeUpscaler(extra?: Record<string, unknown>): AiUpscaler;
  makeFile(size?: number): Promise<File>;
  makeTransparentFile(size?: number): Promise<File>;
  pixels(blob: Blob): Promise<{ width: number; height: number; data: number[] }>;
  detectCapabilities(): Promise<Record<string, unknown>>;
}

interface AiUpscaler {
  upscale(input: unknown, options?: Record<string, unknown>): Promise<{
    blob: Blob;
    width: number;
    height: number;
    engine: string;
    runtime: string;
    format: string;
    processingTime: number;
  }>;
  models: {
    list(): Promise<Array<Record<string, unknown>>>;
    isInstalled(id: string): Promise<boolean>;
    download(id: string, options?: Record<string, unknown>): Promise<ArrayBuffer>;
    delete(id: string): Promise<boolean>;
    register(definition: Record<string, unknown>): void;
    usage(): Promise<number>;
  };
  dispose(): Promise<void>;
}

declare global {
  interface Window {
    ai: AiHarness;
    aiReady?: boolean;
  }
}

async function openHarness(page: Page): Promise<void> {
  await page.goto(AI_PAGE);
  await page.waitForFunction(() => window.aiReady === true, undefined, { timeout: 30_000 });
}

test.describe('model catalogue', () => {
  test('lists models with licence, size and attribution', async ({ page }) => {
    await openHarness(page);
    const models = await page.evaluate(async () => {
      const upscaler = window.ai.makeUpscaler();
      const list = await upscaler.models.list();
      await upscaler.dispose();
      return list;
    });

    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(typeof model.id).toBe('string');
      expect(model.size as number).toBeGreaterThan(1_000_000);
      // Licence and provenance are a redistribution obligation, not a nicety.
      expect(model.license).toBeTruthy();
      expect(model.source).toBeTruthy();
      expect(model.attribution).toBeTruthy();
      expect(typeof model.installed).toBe('boolean');
    }
    const ids = models.map((m) => m.id);
    expect(ids).toContain('realesrgan-x2');
    expect(ids).toContain('realesrgan-x4');
  });

  test('asking for AI without a model fails with MODEL_NOT_INSTALLED', async ({ page }) => {
    await openHarness(page);
    const outcome = await page.evaluate(async () => {
      const upscaler = window.ai.makeUpscaler();
      // Register a model that will never be installed, so the assertion does
      // not depend on cache state left by another test.
      upscaler.models.register({
        id: 'never-installed-x2',
        name: 'Absent model',
        scale: 2,
        size: 1024,
        version: '1.0.0',
        license: 'MIT',
        source: 'https://example.com',
        url: 'https://example.com/absent.onnx',
      });
      const file = await window.ai.makeFile(24);
      try {
        await upscaler.upscale(file, { scale: 2, engine: 'ai', model: 'never-installed-x2' });
        return { code: 'no error' };
      } catch (error) {
        return {
          code: (error as { code?: string }).code,
          message: (error as Error).message,
        };
      } finally {
        await upscaler.dispose();
      }
    });

    expect(outcome.code).toBe('MODEL_NOT_INSTALLED');
    // The message has to tell the caller what to do about it.
    expect(outcome.message).toMatch(/models\.download/);
  });

  test('auto falls back to classical when no model is installed', async ({ page }) => {
    await openHarness(page);
    const result = await page.evaluate(async () => {
      const upscaler = window.ai.makeUpscaler();
      // A registry with nothing installed: `auto` must not download 67 MB
      // uninvited, and must not fail either.
      const file = await window.ai.makeFile(32);
      const installed = (await upscaler.models.list()).filter((m) => m.installed);
      const out = await upscaler.upscale(file, { scale: 2, engine: 'auto' });
      await upscaler.dispose();
      return { engine: out.engine, width: out.width, installedCount: installed.length };
    });

    if (result.installedCount === 0) {
      expect(result.engine).toBe('classical');
    }
    expect(result.width).toBe(64);
  });

  test('rejects a model definition served over plain http', async ({ page }) => {
    await openHarness(page);
    const message = await page.evaluate(async () => {
      const upscaler = window.ai.makeUpscaler();
      try {
        upscaler.models.register({
          id: 'insecure',
          name: 'Insecure',
          scale: 2,
          size: 10,
          version: '1',
          license: 'MIT',
          source: 'http://example.com',
          url: 'http://example.com/model.onnx',
        });
        return 'accepted';
      } catch (error) {
        return (error as Error).message;
      } finally {
        await upscaler.dispose();
      }
    });
    expect(message).toMatch(/must use https/);
  });
});

test.describe.serial('AI engine, cache and offline', () => {
  /**
   * One browser context for the whole block, created by hand.
   *
   * Playwright gives each test a fresh context, which means fresh IndexedDB -
   * and a cache that is wiped between tests cannot demonstrate that a model
   * persists, nor spare the suite from re-downloading 67 MB seven times. So
   * these tests share a context deliberately, and the ordering between them is
   * part of the specification: download, reload, use, delete.
   */
  let context: Awaited<ReturnType<Browser['newContext']>>;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext();
    page = await context.newPage();
  });

  test.afterAll(async () => {
    await context.close();
  });

  test('downloads the model with real progress and caches it', async () => {
    test.setTimeout(600_000);
    await openHarness(page);

    const download = await page.evaluate(async (id) => {
      const upscaler = window.ai.makeUpscaler();
      // Start clean, so the progress assertions describe a real transfer.
      await upscaler.models.delete(id);

      const samples: Array<{ progress: number | null; loaded: number; total: number | null }> = [];
      const started = performance.now();
      const bytes = await upscaler.models.download(id, {
        onProgress: (p: { progress: number | null; loaded: number; total: number | null }) =>
          samples.push(p),
      });
      const elapsed = performance.now() - started;

      const installed = await upscaler.models.isInstalled(id);
      const usage = await upscaler.models.usage();
      await upscaler.dispose();

      return {
        byteLength: bytes.byteLength,
        installed,
        usage,
        elapsed,
        sampleCount: samples.length,
        first: samples[0],
        last: samples[samples.length - 1],
        monotonic: samples.every((s, i) => i === 0 || s.loaded >= samples[i - 1].loaded),
      };
    }, MODEL_ID);

    // The real file, byte-exact against the registry entry.
    expect(download.byteLength).toBe(67_073_434);
    expect(download.installed).toBe(true);
    expect(download.usage).toBeGreaterThanOrEqual(download.byteLength);
    // Streamed progress, throttled rather than per-chunk.
    expect(download.sampleCount).toBeGreaterThan(1);
    expect(download.monotonic).toBe(true);
    expect(download.last?.progress).toBe(1);
    expect(download.last?.total).toBe(67_073_434);
  });

  test('the cached model survives a page reload', async () => {
    // A real navigation, so the assertion is about persistent storage rather
    // than about anything still held in memory.
    await page.reload();
    await page.waitForFunction(() => window.aiReady === true, undefined, { timeout: 30_000 });
    const installed = await page.evaluate(async (id) => {
      const upscaler = window.ai.makeUpscaler();
      const result = {
        isInstalled: await upscaler.models.isInstalled(id),
        listedInstalled: (await upscaler.models.list()).find((m) => m.id === id)?.installed,
        usage: await upscaler.models.usage(),
      };
      await upscaler.dispose();
      return result;
    }, MODEL_ID);

    expect(installed.isInstalled).toBe(true);
    expect(installed.listedInstalled).toBe(true);
    expect(installed.usage).toBeGreaterThan(60_000_000);
  });

  test('a second download is served from cache without touching the network', async () => {
    await openHarness(page);

    const modelRequests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes(MODEL_HOST)) modelRequests.push(request.url());
    });

    const timing = await page.evaluate(async (id) => {
      const upscaler = window.ai.makeUpscaler();
      const started = performance.now();
      const bytes = await upscaler.models.download(id);
      const elapsed = performance.now() - started;
      await upscaler.dispose();
      return { byteLength: bytes.byteLength, elapsed };
    }, MODEL_ID);

    expect(timing.byteLength).toBe(67_073_434);
    // Nothing went to the model host.
    expect(modelRequests).toEqual([]);
  });

  test('runs real AI inference and produces a genuinely different result', async () => {
    test.setTimeout(600_000);
    await openHarness(page);

    const comparison = await page.evaluate(async (id) => {
      const upscaler = window.ai.makeUpscaler();
      const file = await window.ai.makeFile(48);
      const caps = await window.ai.detectCapabilities();

      const stages: string[] = [];
      const ai = await upscaler.upscale(file, {
        scale: 2,
        engine: 'ai',
        model: id,
        output: { format: 'png' },
        onProgress: (p: { stage: string }) => stages.push(p.stage),
      });
      const aiPixels = await window.ai.pixels(ai.blob);

      const classical = await upscaler.upscale(file, {
        scale: 2,
        engine: 'classical',
        output: { format: 'png' },
      });
      const classicalPixels = await window.ai.pixels(classical.blob);
      await upscaler.dispose();

      // How far the two engines disagree. A stubbed or faked AI path would
      // either match the classical result or be uniform.
      let sum = 0;
      let worst = 0;
      for (let i = 0; i < aiPixels.data.length; i++) {
        const d = Math.abs(aiPixels.data[i] - classicalPixels.data[i]);
        sum += d;
        if (d > worst) worst = d;
      }

      // Distinct colours: proves output is a real image, not a flat fill.
      const distinct = new Set<string>();
      for (let i = 0; i < aiPixels.data.length; i += 4) {
        distinct.add(aiPixels.data.slice(i, i + 3).join(','));
      }

      return {
        engine: ai.engine,
        runtime: ai.runtime,
        webGPUAvailable: caps.webGPU as boolean,
        width: ai.width,
        height: ai.height,
        format: ai.format,
        blobSize: ai.blob.size,
        processingTime: ai.processingTime,
        stages: [...new Set(stages)],
        meanAbsDiff: sum / aiPixels.data.length,
        worstDiff: worst,
        distinctColours: distinct.size,
      };
    }, MODEL_ID);

    expect(comparison.engine).toBe('ai');
    expect(['webgpu', 'wasm']).toContain(comparison.runtime);

    // The reported runtime must be the one that actually ran.
    //
    // This caught a real bug. The session used to be created with
    // `executionProviders: ['webgpu', 'wasm']`, and ONNX Runtime falls back
    // within that list silently - so a session that really ran on WASM was
    // labelled `webgpu`, on a machine whose capability probe said WebGPU was
    // unavailable. `runtime` is public, and consumers use it to decide what to
    // offer, so it has to be true.
    if (!comparison.webGPUAvailable) {
      expect(
        comparison.runtime,
        'claimed webgpu without an available adapter',
      ).toBe('wasm');
    }
    expect(comparison.width).toBe(96);
    expect(comparison.height).toBe(96);
    expect(comparison.format).toBe('png');
    expect(comparison.blobSize).toBeGreaterThan(1000);
    expect(comparison.processingTime).toBeGreaterThan(0);
    // A real network produces a substantially different image from Lanczos.
    expect(comparison.meanAbsDiff).toBeGreaterThan(1);
    expect(comparison.worstDiff).toBeGreaterThan(10);
    expect(comparison.distinctColours).toBeGreaterThan(50);
  });

  test('the hybrid engine runs and differs from both of its parts', async () => {
    test.setTimeout(600_000);
    await openHarness(page);

    const result = await page.evaluate(async (id) => {
      const upscaler = window.ai.makeUpscaler();
      const file = await window.ai.makeFile(48);

      const hybrid = await upscaler.upscale(file, {
        scale: 2,
        engine: 'hybrid',
        model: id,
        output: { format: 'png' },
      });
      const ai = await upscaler.upscale(file, {
        scale: 2,
        engine: 'ai',
        model: id,
        output: { format: 'png' },
      });

      const h = await window.ai.pixels(hybrid.blob);
      const a = await window.ai.pixels(ai.blob);
      await upscaler.dispose();

      let sum = 0;
      for (let i = 0; i < h.data.length; i++) sum += Math.abs(h.data[i] - a.data[i]);

      return {
        engine: hybrid.engine,
        runtime: hybrid.runtime,
        width: hybrid.width,
        meanAbsDiff: sum / h.data.length,
      };
    }, MODEL_ID);

    expect(result.engine).toBe('hybrid');
    expect(result.width).toBe(96);
    // Detail re-injection genuinely changes the network's output.
    expect(result.meanAbsDiff).toBeGreaterThan(0.3);
  });

  test('AI preserves transparency by carrying alpha separately', async () => {
    test.setTimeout(600_000);
    await openHarness(page);

    const analysis = await page.evaluate(async (id) => {
      const upscaler = window.ai.makeUpscaler();
      const file = await window.ai.makeTransparentFile(48);

      // The disc is #00c070, so a correct soft edge is that colour - not white,
      // and certainly not black.
      const DISC = [0x00, 0xc0, 0x70];

      /**
       * Colour error at a partially transparent pixel, weighted by alpha.
       *
       * The weighting is the point. A PNG read back through a canvas has been
       * un-premultiplied from an 8-bit premultiplied store, so at alpha 1/255
       * the colour has been divided by 1/255 and is numerically meaningless -
       * both engines report a full-scale "error" on such a pixel. Weighting by
       * alpha measures what a viewer can actually see when the image is
       * composited, which is the property that matters.
       */
      const measure = async (
        options: Record<string, unknown>,
      ): Promise<{
        worst: number;
        mean: number;
        worstPixel: number[];
        transparent: number;
        opaque: number;
        semi: number;
        format: string;
      }> => {
        const out = await upscaler.upscale(file, {
          scale: 2,
          output: { format: 'png' },
          ...options,
        });
        const pixels = await window.ai.pixels(out.blob);

        let transparent = 0;
        let opaque = 0;
        let semi = 0;
        let worst = 0;
        let sum = 0;
        let worstPixel: number[] = [];

        for (let i = 0; i < pixels.data.length; i += 4) {
          const a = pixels.data[i + 3];
          if (a === 0) {
            transparent++;
            continue;
          }
          if (a === 255) {
            opaque++;
            continue;
          }
          semi++;
          let deviation = 0;
          for (let c = 0; c < 3; c++) {
            deviation = Math.max(deviation, Math.abs(pixels.data[i + c] - DISC[c]) / 255);
          }
          const visible = deviation * (a / 255);
          sum += visible;
          if (visible > worst) {
            worst = visible;
            worstPixel = [
              pixels.data[i],
              pixels.data[i + 1],
              pixels.data[i + 2],
              pixels.data[i + 3],
            ];
          }
        }

        return {
          worst,
          mean: semi > 0 ? sum / semi : 0,
          worstPixel,
          transparent,
          opaque,
          semi,
          format: out.format,
        };
      };

      const ai = await measure({ engine: 'ai', model: id });
      const classical = await measure({ engine: 'classical' });
      await upscaler.dispose();
      return { ai, classical };
    }, MODEL_ID);

    // Real transparency survived in both directions.
    expect(analysis.ai.format).toBe('png');
    expect(analysis.ai.transparent).toBeGreaterThan(100);
    expect(analysis.ai.opaque).toBeGreaterThan(100);
    expect(analysis.ai.semi).toBeGreaterThan(0);

    console.log(
      `[transparency] ai mean=${analysis.ai.mean.toFixed(4)} worst=${analysis.ai.worst.toFixed(4)} ` +
        `rgba(${analysis.ai.worstPixel.join(',')}) | classical mean=` +
        `${analysis.classical.mean.toFixed(4)} worst=${analysis.classical.worst.toFixed(4)}`,
    );

    // No visible fringe: at most a few 8-bit levels of composited error.
    expect(analysis.ai.worst).toBeLessThan(0.08);
    expect(analysis.ai.mean).toBeLessThan(0.03);

    // And the AI path is no worse at this than the classical one, which is the
    // comparison that would catch an alpha-handling regression specific to the
    // network path.
    expect(analysis.ai.worst).toBeLessThan(analysis.classical.worst + 0.05);
  });

  test('AI inference can be cancelled', async () => {
    test.setTimeout(600_000);
    await openHarness(page);

    const outcome = await page.evaluate(async (id) => {
      const upscaler = window.ai.makeUpscaler();
      // Big enough to be tiled, so there is a cancellation point to hit.
      const file = await window.ai.makeFile(700);
      const controller = new AbortController();
      const promise = upscaler.upscale(file, {
        scale: 2,
        engine: 'ai',
        model: id,
        tileSize: 128,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 400);
      try {
        await promise;
        return { cancelled: false };
      } catch (error) {
        return { cancelled: true, code: (error as { code?: string }).code };
      } finally {
        await upscaler.dispose();
      }
    }, MODEL_ID);

    expect(outcome.cancelled).toBe(true);
    expect(outcome.code).toBe('CANCELLED');
  });

  test('works with the network cut off, from the cached model alone', async () => {
    test.setTimeout(600_000);
    await openHarness(page);

    // Cut every external request. The library may only touch its own origin,
    // where the runtime and page live.
    const blocked: string[] = [];
    await page.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.startsWith('http://localhost:4173')) {
        await route.continue();
        return;
      }
      blocked.push(url);
      await route.abort('internetdisconnected');
    });

    // Reload so nothing is left in memory: the model has to come from storage.
    await openHarness(page);

    const result = await page.evaluate(async (id) => {
      const upscaler = window.ai.makeUpscaler();
      const installed = await upscaler.models.isInstalled(id);
      const file = await window.ai.makeFile(48);
      const out = await upscaler.upscale(file, {
        scale: 2,
        engine: 'ai',
        model: id,
        output: { format: 'png' },
      });
      await upscaler.dispose();
      return {
        installed,
        engine: out.engine,
        runtime: out.runtime,
        width: out.width,
        blobSize: out.blob.size,
      };
    }, MODEL_ID);

    expect(result.installed).toBe(true);
    expect(result.engine).toBe('ai');
    expect(result.width).toBe(96);
    expect(result.blobSize).toBeGreaterThan(1000);
    // Nothing outside the origin was even attempted.
    expect(blocked).toEqual([]);

    // Put the network back: this context is shared with the tests that follow.
    await page.unroute('**/*');
  });

  test('detects a corrupted cached model and discards it', async () => {
    test.setTimeout(600_000);
    await openHarness(page);

    const outcome = await page.evaluate(async () => {
      const upscaler = window.ai.makeUpscaler();
      // Same real URL, deliberately wrong checksum: this is what a tampered or
      // truncated file looks like from the library's point of view.
      upscaler.models.register({
        id: 'realesrgan-x2-badhash',
        name: 'Real-ESRGAN 2x (wrong checksum)',
        scale: 2,
        size: 67_073_434,
        version: '1.0.0',
        license: 'BSD-3-Clause',
        source: 'https://huggingface.co/SceneWorks/real-esrgan-onnx',
        url: 'https://huggingface.co/SceneWorks/real-esrgan-onnx/resolve/main/real_esrgan_x2.onnx',
        sha256: '0'.repeat(64),
      });

      try {
        await upscaler.models.download('realesrgan-x2-badhash', { retries: 0 });
        return { code: 'no error' };
      } catch (error) {
        const e = error as { code?: string; details?: Record<string, unknown> };
        return {
          code: e.code,
          expected: e.details?.expected,
          actual: e.details?.actual,
          // A rejected model must not have been stored.
          installedAfter: await upscaler.models.isInstalled('realesrgan-x2-badhash'),
        };
      } finally {
        await upscaler.dispose();
      }
    });

    expect(outcome.code).toBe('MODEL_CORRUPTED');
    expect(outcome.expected).toBe('0'.repeat(64));
    // The real digest, reported so the caller can see what arrived.
    expect(outcome.actual).toBe(
      '7115ba92e8a1bfa63d68558ef006ef3d91273a068d321b1439f8bb1c9179002c',
    );
    expect(outcome.installedAfter).toBe(false);
  });

  test('reports MODEL_DOWNLOAD_FAILED for an unreachable model host', async () => {
    await openHarness(page);
    const outcome = await page.evaluate(async () => {
      const upscaler = window.ai.makeUpscaler();
      upscaler.models.register({
        id: 'unreachable',
        name: 'Unreachable',
        scale: 2,
        size: 1024,
        version: '1.0.0',
        license: 'MIT',
        source: 'https://models.invalid',
        url: 'https://models.invalid/nope.onnx',
      });
      try {
        await upscaler.models.download('unreachable', { retries: 0 });
        return { code: 'no error' };
      } catch (error) {
        return { code: (error as { code?: string }).code };
      } finally {
        await upscaler.dispose();
      }
    });
    expect(outcome.code).toBe('MODEL_DOWNLOAD_FAILED');
  });

  test('deleting a model frees the storage and makes AI unavailable again', async () => {
    await openHarness(page);
    const outcome = await page.evaluate(async (id) => {
      const upscaler = window.ai.makeUpscaler();
      const before = await upscaler.models.usage();
      const deleted = await upscaler.models.delete(id);
      const after = await upscaler.models.usage();
      const installed = await upscaler.models.isInstalled(id);

      let code = 'no error';
      try {
        const file = await window.ai.makeFile(24);
        await upscaler.upscale(file, { scale: 2, engine: 'ai', model: id });
      } catch (error) {
        code = (error as { code?: string }).code ?? 'unknown';
      }
      await upscaler.dispose();
      return { before, after, deleted, installed, code };
    }, MODEL_ID);

    expect(outcome.deleted).toBe(true);
    expect(outcome.installed).toBe(false);
    expect(outcome.after).toBeLessThan(outcome.before);
    expect(outcome.code).toBe('MODEL_NOT_INSTALLED');
  });
});

test.describe('network privacy', () => {
  test('a classical upscale makes no network request at all', async ({ page }) => {
    // The central privacy claim. Recorded at the browser level, so it covers
    // anything the library could possibly do - fetch, XHR, beacon, image.
    const requests: string[] = [];
    page.on('request', (request) => requests.push(`${request.method()} ${request.url()}`));

    await page.goto('/tests/e2e/pages/script-tag.html');
    const requestsAfterLoad = requests.length;

    const result = await page.evaluate(async () => {
      const Ctor = (window as never as { ImageUpscaler: new (c?: object) => never })
        .ImageUpscaler;
      const harness = (window as never as { harness: { makeFile(s?: number): Promise<File> } })
        .harness;
      const file = await harness.makeFile(128);
      const upscaler = new Ctor({ useWorker: false }) as {
        upscale(i: File, o: object): Promise<{ width: number }>;
        dispose(): Promise<void>;
      };
      const out = await upscaler.upscale(file, { scale: 4, engine: 'classical' });
      await upscaler.dispose();
      return { width: out.width };
    });

    expect(result.width).toBe(512);
    // Not one request beyond loading the page itself.
    const duringProcessing = requests.slice(requestsAfterLoad);
    expect(duringProcessing).toEqual([]);
  });

  test('no request carries image data, and none is a POST', async ({ page }) => {
    const posts: string[] = [];
    const withBodies: string[] = [];
    page.on('request', (request) => {
      if (request.method() !== 'GET' && request.method() !== 'HEAD') {
        posts.push(`${request.method()} ${request.url()}`);
      }
      const body = request.postData();
      if (body) withBodies.push(`${request.method()} ${request.url()} (${body.length} bytes)`);
    });

    await openHarness(page);

    await page.evaluate(async () => {
      const upscaler = window.ai.makeUpscaler();
      const file = await window.ai.makeFile(96);
      await upscaler.upscale(file, { scale: 2, engine: 'classical' });
      await upscaler.dispose();
    });

    // Nothing is uploaded, and nothing has a body to upload with.
    expect(posts).toEqual([]);
    expect(withBodies).toEqual([]);
  });

  test('the only third-party host the library ever contacts is the model host', async ({
    page,
  }) => {
    test.setTimeout(600_000);
    const externalHosts = new Set<string>();
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.host !== 'localhost:4173') externalHosts.add(url.host);
    });

    await openHarness(page);
    await page.evaluate(async (id) => {
      const upscaler = window.ai.makeUpscaler();
      // Downloading weights is the one legitimate outbound request, and it is
      // a GET for a public file.
      await upscaler.models.delete(id);
      await upscaler.models.download(id);
      const file = await window.ai.makeFile(32);
      await upscaler.upscale(file, { scale: 2, engine: 'ai', model: id });
      await upscaler.dispose();
    }, MODEL_ID);

    const hosts = [...externalHosts];
    for (const host of hosts) {
      // Hugging Face redirects weight downloads to its CDN.
      expect(
        host.endsWith('huggingface.co') || host.endsWith('hf.co'),
        `unexpected host contacted: ${host}`,
      ).toBe(true);
    }
    // And it really did contact one, so the assertion is not vacuous.
    expect(hosts.length).toBeGreaterThan(0);
  });
});
