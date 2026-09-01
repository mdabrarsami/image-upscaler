import { expect, test } from '@playwright/test';

/**
 * Worker and GPU paths.
 *
 * Two claims that cannot be checked by inspection: that the core never touches
 * the DOM (so it runs inside a Worker), and that the GPU resample agrees with
 * the CPU one within float tolerance and falls back cleanly when it cannot run.
 */

test.describe('Web Worker', () => {
  test('the core runs inside a module Worker with no DOM at all', async ({ page }) => {
    await page.goto('/tests/e2e/pages/worker.html');
    const result = await page.evaluate(() =>
      (window as never as { runInWorker(o: object): Promise<Record<string, unknown>> }).runInWorker({
        size: 64,
        scale: 2,
      }),
    );

    expect(result.ok, String(result.message ?? '')).toBe(true);
    expect(result.environment).toBe('worker');
    expect(result.width).toBe(128);
    expect(result.height).toBe(128);
    expect(result.engine).toBe('classical');
    expect(result.format).toBe('png');
    expect(result.blobSize as number).toBeGreaterThan(500);
    expect(result.stages as string[]).toContain('encoding');
  });

  test('handles 4x inside a Worker too', async ({ page }) => {
    await page.goto('/tests/e2e/pages/worker.html');
    const result = await page.evaluate(() =>
      (window as never as { runInWorker(o: object): Promise<Record<string, unknown>> }).runInWorker({
        size: 48,
        scale: 4,
        mode: 'detail',
      }),
    );
    expect(result.ok, String(result.message ?? '')).toBe(true);
    expect(result.width).toBe(192);
  });

  test('useWorker: true keeps the main thread responsive', async ({ page }) => {
    await page.goto('/tests/e2e/pages/script-tag.html');

    const timing = await page.evaluate(async () => {
      const Ctor = (window as never as { ImageUpscaler: new (c?: object) => never })
        .ImageUpscaler;
      const harness = (window as never as { harness: { makeFile(s?: number): Promise<File> } })
        .harness;

      const file = await harness.makeFile(320);
      const upscaler = new Ctor({
        useWorker: true,
        // A classic script has no import.meta.url, so the worker URL has to be
        // supplied. This is the documented behaviour for script-tag consumers.
        workerUrl: new URL('/packages/image-upscaler/dist/worker.js', location.origin).href,
      }) as {
        upscale(i: File, o: object): Promise<{ width: number; runtime: string; engine: string }>;
        dispose(): Promise<void>;
      };

      // Sample how long the main thread is blocked between animation frames
      // while the upscale runs. A main-thread run shows multi-hundred-ms gaps.
      const gaps: number[] = [];
      let previous = performance.now();
      let sampling = true;
      const sample = (): void => {
        const now = performance.now();
        gaps.push(now - previous);
        previous = now;
        if (sampling) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);

      const result = await upscaler.upscale(file, { scale: 4, engine: 'classical' });
      sampling = false;
      await upscaler.dispose();

      return {
        width: result.width,
        worstGap: Math.max(...gaps),
        frames: gaps.length,
      };
    });

    expect(timing.width).toBe(1280);
    // The frame loop kept running throughout.
    expect(timing.frames).toBeGreaterThan(5);
    // Generous, because CI machines stall for unrelated reasons; a main-thread
    // 4x of a 320px image blocks for far longer than this.
    expect(timing.worstGap).toBeLessThan(1500);
  });

  test('falls back to the calling thread when the worker URL is wrong', async ({ page }) => {
    await page.goto('/tests/e2e/pages/script-tag.html');
    const result = await page.evaluate(async () => {
      const Ctor = (window as never as { ImageUpscaler: new (c?: object) => never })
        .ImageUpscaler;
      const harness = (window as never as { harness: { makeFile(s?: number): Promise<File> } })
        .harness;
      const file = await harness.makeFile(32);

      const upscaler = new Ctor({
        useWorker: true,
        workerUrl: '/tests/e2e/pages/does-not-exist.js',
      }) as {
        upscale(i: File, o: object): Promise<{ width: number }>;
        dispose(): Promise<void>;
      };

      // Must still produce a result: a broken worker is a degraded mode, not a
      // failure mode.
      const out = await upscaler.upscale(file, { scale: 2, engine: 'classical' });
      await upscaler.dispose();
      return { width: out.width };
    });
    expect(result.width).toBe(64);
  });

  test('cancellation reaches into the worker', async ({ page }) => {
    await page.goto('/tests/e2e/pages/script-tag.html');
    const outcome = await page.evaluate(async () => {
      const global = window as never as {
        ImageUpscaler: (new (c?: object) => never) & { isCancellation(e: unknown): boolean };
        harness: { makeFile(s?: number): Promise<File> };
      };
      const file = await global.harness.makeFile(400);
      const upscaler = new global.ImageUpscaler({
        useWorker: true,
        workerUrl: new URL('/packages/image-upscaler/dist/worker.js', location.origin).href,
      }) as {
        upscale(i: File, o: object): Promise<unknown>;
        dispose(): Promise<void>;
      };

      const controller = new AbortController();
      const promise = upscaler.upscale(file, {
        scale: 8,
        engine: 'classical',
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 80);

      try {
        await promise;
        return { cancelled: false };
      } catch (error) {
        return {
          cancelled: true,
          code: (error as { code?: string }).code,
          recognised: global.ImageUpscaler.isCancellation(error),
        };
      } finally {
        await upscaler.dispose();
      }
    });

    expect(outcome.cancelled).toBe(true);
    expect(outcome.code).toBe('CANCELLED');
    expect(outcome.recognised).toBe(true);
  });
});

test.describe('WebGPU', () => {
  test('reports GPU availability honestly', async ({ page }) => {
    await page.goto('/tests/e2e/pages/script-tag.html');
    const info = await page.evaluate(async () => {
      const global = (window as never as {
        ImageUpscaler: { detectCapabilities(): Promise<Record<string, unknown>> };
      }).ImageUpscaler;
      const caps = await global.detectCapabilities();
      let adapter: unknown = null;
      const nav = navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } };
      if (nav.gpu) {
        try {
          adapter = await nav.gpu.requestAdapter();
        } catch {
          adapter = null;
        }
      }
      return {
        reported: caps.webGPU,
        maxTextureSize: caps.maxTextureSize,
        maxBufferSize: caps.maxBufferSize,
        adapterExists: adapter !== null,
      };
    });

    // The claim must match the probe, in both directions.
    expect(info.reported).toBe(info.adapterExists);
    if (info.reported) {
      expect(info.maxBufferSize as number).toBeGreaterThan(0);
      expect(info.maxTextureSize as number).toBeGreaterThan(0);
    }
  });

  test('the GPU resample agrees with the CPU one within float tolerance', async ({ page }) => {
    await page.goto('/tests/e2e/pages/esm.html');

    const comparison = await page.evaluate(async () => {
      // Compared at the resample stage rather than end to end: folding in the
      // other eight passes would blunt the very difference being measured.
      const module = await import('/packages/image-upscaler/dist/index.js');

      const gpu = await module.GPUResampler.create();
      if (!gpu) return { skipped: true as const };

      const surface = module.createSurface(65, 33, 'linear', true);
      // Deterministic high-frequency content: a smooth image would agree
      // trivially, since the kernel weights dominate.
      let state = 12345;
      const next = (): number => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x100000000;
      };
      for (let i = 0; i < surface.data.length; i += 4) {
        surface.data[i] = next();
        surface.data[i + 1] = next();
        surface.data[i + 2] = next();
        surface.data[i + 3] = 1;
      }

      const results: Array<{
        kernel: string;
        size: [number, number];
        worst: number;
        rms: number;
      }> = [];

      for (const kernel of ['bilinear', 'bicubic', 'lanczos3', 'lanczos4'] as const) {
        const cpu = module.resample(surface, 130, 66, { kernel: module.getKernel(kernel) });
        const fromGpu = await gpu.resample(surface, 130, 66, kernel);

        let worst = 0;
        let sumSq = 0;
        for (let i = 0; i < cpu.data.length; i++) {
          const d = Math.abs(cpu.data[i] - fromGpu.data[i]);
          if (d > worst) worst = d;
          sumSq += d * d;
        }
        results.push({
          kernel,
          size: [fromGpu.width, fromGpu.height],
          worst,
          rms: Math.sqrt(sumSq / cpu.data.length),
        });
      }

      gpu.dispose();
      return { skipped: false as const, results };
    });

    if (comparison.skipped) {
      test.skip(true, 'no WebGPU adapter in this environment');
      return;
    }

    expect(comparison.results).toHaveLength(4);
    for (const result of comparison.results) {
      expect(result.size, result.kernel).toEqual([130, 66]);
      // The two paths run the same weight tables in a different accumulation
      // order, so they agree to float precision, not bit-for-bit. 1e-4 is well
      // inside a 16-bit least significant bit.
      expect(result.worst, `${result.kernel} worst`).toBeLessThan(1e-4);
      expect(result.rms, `${result.kernel} rms`).toBeLessThan(1e-5);
    }
  });

  test('surfaces a GPU buffer limit as a precise error rather than crashing', async ({ page }) => {
    await page.goto('/tests/e2e/pages/esm.html');
    const outcome = await page.evaluate(async () => {
      const module = await import('/packages/image-upscaler/dist/index.js');
      const gpu = await module.GPUResampler.create();
      if (!gpu) return { skipped: true as const };

      // Deliberately ask for an output larger than any storage binding allows.
      const surface = module.createSurface(64, 64, 'linear', true);
      try {
        await gpu.resample(surface, 40000, 40000, 'lanczos3');
        return { skipped: false as const, code: 'no error' };
      } catch (error) {
        return { skipped: false as const, code: (error as { code?: string }).code };
      } finally {
        gpu.dispose();
      }
    });

    if (outcome.skipped) {
      test.skip(true, 'no WebGPU adapter in this environment');
      return;
    }
    // A typed error the caller can act on (by tiling), not an opaque GPU fault.
    expect(['OUT_OF_MEMORY', 'IMAGE_TOO_LARGE', 'GPU_UNAVAILABLE']).toContain(outcome.code);
  });

  test('produces identical results with the GPU enabled and disabled', async ({ page }) => {
    await page.goto('/tests/e2e/pages/script-tag.html');

    const outcome = await page.evaluate(async () => {
      const global = window as never as {
        ImageUpscaler: (new (c?: object) => never) & {
          detectCapabilities(): Promise<Record<string, unknown>>;
        };
        harness: {
          makeFile(s?: number): Promise<File>;
          pixels(b: Blob): Promise<{ width: number; height: number; data: number[] }>;
        };
      };

      const caps = await global.ImageUpscaler.detectCapabilities();
      const file = await global.harness.makeFile(64);

      // `warmUp` is what attaches the GPU resampler; skipping it keeps the run
      // on the CPU. Both must produce a valid, visually equivalent result.
      const cpuUpscaler = new global.ImageUpscaler({ useWorker: false }) as {
        upscale(i: File, o: object): Promise<{ blob: Blob; runtime: string }>;
        warmUp(): Promise<void>;
        dispose(): Promise<void>;
      };
      const cpu = await cpuUpscaler.upscale(file, {
        scale: 2,
        engine: 'classical',
        output: { format: 'png' },
      });
      const cpuPixels = await global.harness.pixels(cpu.blob);
      const cpuRuntime = cpu.runtime;
      await cpuUpscaler.dispose();

      const gpuUpscaler = new global.ImageUpscaler({ useWorker: false }) as {
        upscale(i: File, o: object): Promise<{ blob: Blob; runtime: string }>;
        warmUp(): Promise<void>;
        dispose(): Promise<void>;
      };
      await gpuUpscaler.warmUp();
      const gpu = await gpuUpscaler.upscale(file, {
        scale: 2,
        engine: 'classical',
        output: { format: 'png' },
      });
      const gpuPixels = await global.harness.pixels(gpu.blob);
      const gpuRuntime = gpu.runtime;
      await gpuUpscaler.dispose();

      let worst = 0;
      let sum = 0;
      for (let i = 0; i < cpuPixels.data.length; i++) {
        const d = Math.abs(cpuPixels.data[i] - gpuPixels.data[i]);
        if (d > worst) worst = d;
        sum += d;
      }

      return {
        webGPU: caps.webGPU as boolean,
        cpuRuntime,
        gpuRuntime,
        size: [gpuPixels.width, gpuPixels.height],
        worst,
        meanAbs: sum / cpuPixels.data.length,
      };
    });

    expect(outcome.size).toEqual([128, 128]);
    expect(outcome.cpuRuntime).toBe('cpu');

    if (!outcome.webGPU) {
      // No adapter: the GPU path must have declined rather than failed.
      expect(outcome.gpuRuntime).toBe('cpu');
      expect(outcome.worst).toBe(0);
      return;
    }

    expect(outcome.gpuRuntime).toBe('webgpu');
    // Float accumulation order differs between the two, so exact equality is
    // not the right bar. A couple of 8-bit levels is.
    expect(outcome.worst).toBeLessThanOrEqual(2);
    expect(outcome.meanAbs).toBeLessThan(0.2);
  });
});
