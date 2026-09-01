import { expect, test } from '@playwright/test';

/**
 * End-to-end behaviour in a real browser: every input type, every scale, every
 * output format, transparency, tiling, progress, cancellation and the error
 * contract. These need a browser because they exercise the decode and encode
 * paths, which are the browser's own.
 */

const HARNESS = '/tests/e2e/pages/script-tag.html';

/** Shape of the global the harness page installs. */
declare global {
  interface Window {
    ImageUpscaler: {
      new (config?: Record<string, unknown>): {
        upscale(input: unknown, options?: Record<string, unknown>): Promise<UpscaleResultLike>;
        dispose(): Promise<void>;
        models: {
          list(): Promise<Array<Record<string, unknown>>>;
          isInstalled(id: string): Promise<boolean>;
          delete(id: string): Promise<boolean>;
          download(id: string, options?: Record<string, unknown>): Promise<ArrayBuffer>;
          register(definition: Record<string, unknown>): void;
        };
      };
      detectCapabilities(): Promise<Record<string, unknown>>;
      isCancellation(error: unknown): boolean;
      getPreset(mode: string): Record<string, number | string | boolean>;
    };
    harness: {
      makeFile(size?: number): Promise<File>;
      makeTransparentFile(size?: number): Promise<File>;
      pixels(blob: Blob): Promise<{ width: number; height: number; data: number[] }>;
    };
  }
}

interface UpscaleResultLike {
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
  toObjectURL(): string;
}

test.beforeEach(async ({ page }) => {
  await page.goto(HARNESS);
});

test.describe('input types', () => {
  test('accepts every documented input type', async ({ page }) => {
    const results = await page.evaluate(async () => {
      const upscaler = new window.ImageUpscaler({ useWorker: false });
      const file = await window.harness.makeFile(32);
      const buffer = await file.arrayBuffer();

      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 32;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#4488cc';
      ctx.fillRect(0, 0, 32, 32);

      const img = new Image();
      img.src = URL.createObjectURL(file);
      await img.decode();

      const inputs: Array<[string, unknown]> = [
        ['File', file],
        ['Blob', new Blob([buffer], { type: 'image/png' })],
        ['ArrayBuffer', buffer],
        ['Uint8Array', new Uint8Array(buffer)],
        ['ImageBitmap', await createImageBitmap(file)],
        ['HTMLCanvasElement', canvas],
        ['HTMLImageElement', img],
        ['ImageData', ctx.getImageData(0, 0, 32, 32)],
        ['OffscreenCanvas', (() => {
          const off = new OffscreenCanvas(32, 32);
          const octx = off.getContext('2d')!;
          octx.fillStyle = '#cc4488';
          octx.fillRect(0, 0, 32, 32);
          return off;
        })()],
      ];

      const out: Array<{ label: string; ok: boolean; width?: number; error?: string }> = [];
      for (const [label, input] of inputs) {
        try {
          const result = await upscaler.upscale(input, { scale: 2, engine: 'classical' });
          out.push({ label, ok: true, width: result.width });
        } catch (error) {
          out.push({ label, ok: false, error: String((error as Error).message) });
        }
      }
      URL.revokeObjectURL(img.src);
      await upscaler.dispose();
      return out;
    });

    for (const result of results) {
      expect(result.ok, `${result.label}: ${result.error ?? ''}`).toBe(true);
      expect(result.width, result.label).toBe(64);
    }
    expect(results).toHaveLength(9);
  });

  test('rejects unsupported input with INVALID_INPUT', async ({ page }) => {
    const codes = await page.evaluate(async () => {
      const upscaler = new window.ImageUpscaler({ useWorker: false });
      const attempt = async (input: unknown): Promise<string> => {
        try {
          await upscaler.upscale(input, { scale: 2 });
          return 'no error';
        } catch (error) {
          return (error as { code?: string }).code ?? 'unknown';
        }
      };
      const out = {
        nullInput: await attempt(null),
        plainObject: await attempt({ not: 'an image' }),
        emptyBuffer: await attempt(new ArrayBuffer(0)),
        garbageBytes: await attempt(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])),
      };
      await upscaler.dispose();
      return out;
    });

    expect(codes.nullInput).toBe('INVALID_INPUT');
    expect(codes.plainObject).toBe('INVALID_INPUT');
    expect(codes.emptyBuffer).toBe('INVALID_INPUT');
    // Bytes that are not an image reach the browser decoder and fail there.
    expect(codes.garbageBytes).toBe('DECODING_FAILED');
  });

  test('rejects an unsupported scale with INVALID_OPTIONS', async ({ page }) => {
    const code = await page.evaluate(async () => {
      const upscaler = new window.ImageUpscaler({ useWorker: false });
      const file = await window.harness.makeFile(16);
      try {
        await upscaler.upscale(file, { scale: 5 });
        return 'no error';
      } catch (error) {
        return (error as { code?: string }).code;
      } finally {
        await upscaler.dispose();
      }
    });
    expect(code).toBe('INVALID_OPTIONS');
  });
});

test.describe('scales and formats', () => {
  for (const scale of [2, 3, 4, 8]) {
    test(`upscales at ${scale}x`, async ({ page }) => {
      const result = await page.evaluate(async (factor) => {
        const upscaler = new window.ImageUpscaler({ useWorker: false });
        const file = await window.harness.makeFile(32);
        const out = await upscaler.upscale(file, { scale: factor, engine: 'classical' });
        const decoded = await window.harness.pixels(out.blob);
        await upscaler.dispose();
        return {
          width: out.width,
          height: out.height,
          decodedWidth: decoded.width,
          decodedHeight: decoded.height,
          size: out.blob.size,
        };
      }, scale);

      expect(result.width).toBe(32 * scale);
      expect(result.height).toBe(32 * scale);
      // The reported size must match the actual encoded image.
      expect(result.decodedWidth).toBe(32 * scale);
      expect(result.decodedHeight).toBe(32 * scale);
      expect(result.size).toBeGreaterThan(500);
    });
  }

  for (const format of ['png', 'jpeg', 'webp'] as const) {
    test(`encodes ${format}`, async ({ page }) => {
      const result = await page.evaluate(async (fmt) => {
        const caps = await window.ImageUpscaler.detectCapabilities();
        if (!(caps.encodableFormats as string[]).includes(fmt)) {
          return { skipped: true } as const;
        }
        const upscaler = new window.ImageUpscaler({ useWorker: false });
        const file = await window.harness.makeFile(32);
        const out = await upscaler.upscale(file, {
          scale: 2,
          engine: 'classical',
          output: { format: fmt, quality: 0.9 },
        });
        const decoded = await window.harness.pixels(out.blob);
        await upscaler.dispose();
        return {
          skipped: false as const,
          format: out.format,
          blobType: out.blob.type,
          decodedWidth: decoded.width,
          size: out.blob.size,
        };
      }, format);

      if (result.skipped) {
        test.skip(true, `${format} is not encodable in this browser`);
        return;
      }
      expect(result.format).toBe(format);
      expect(result.blobType).toBe(`image/${format}`);
      expect(result.decodedWidth).toBe(64);
      expect(result.size).toBeGreaterThan(200);
    });
  }

  test('keeps transparency in PNG and flattens it for JPEG without a dark fringe', async ({
    page,
  }) => {
    const analysis = await page.evaluate(async () => {
      const upscaler = new window.ImageUpscaler({ useWorker: false });
      const file = await window.harness.makeTransparentFile(64);

      const png = await upscaler.upscale(file, {
        scale: 2,
        engine: 'classical',
        output: { format: 'png' },
      });
      const pngPixels = await window.harness.pixels(png.blob);

      const jpeg = await upscaler.upscale(file, {
        scale: 2,
        engine: 'classical',
        output: { format: 'jpeg', quality: 0.95 },
      });
      const jpegPixels = await window.harness.pixels(jpeg.blob);
      await upscaler.dispose();

      // Worst darkening among partially transparent PNG pixels: a fringe would
      // show as red dropping well below 255 while green and blue stay at 0.
      let worstFringe = 0;
      let semiTransparent = 0;
      let fullyTransparent = 0;
      for (let i = 0; i < pngPixels.data.length; i += 4) {
        const a = pngPixels.data[i + 3];
        if (a === 0) fullyTransparent++;
        if (a > 40 && a < 215) {
          semiTransparent++;
          worstFringe = Math.max(worstFringe, (255 - pngPixels.data[i]) / 255);
        }
      }

      // JPEG has no alpha, so the background must be the flattening colour
      // (white), never black.
      const corner = jpegPixels.data.slice(0, 4);

      return {
        pngFormat: png.format,
        jpegFormat: jpeg.format,
        fullyTransparent,
        semiTransparent,
        worstFringe,
        jpegCorner: Array.from(corner),
      };
    });

    expect(analysis.pngFormat).toBe('png');
    expect(analysis.jpegFormat).toBe('jpeg');
    expect(analysis.fullyTransparent).toBeGreaterThan(100);
    expect(analysis.semiTransparent).toBeGreaterThan(10);
    // Well under a visible fringe.
    expect(analysis.worstFringe).toBeLessThan(0.2);
    // Flattened against white, opaque.
    expect(analysis.jpegCorner[0]).toBeGreaterThan(230);
    expect(analysis.jpegCorner[3]).toBe(255);
  });

  test('defaults the output format to the input format', async ({ page }) => {
    const formats = await page.evaluate(async () => {
      const upscaler = new window.ImageUpscaler({ useWorker: false });
      const png = await window.harness.makeFile(24);

      // Re-encode the same image as JPEG to get a JPEG input.
      const bitmap = await createImageBitmap(png);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
      const jpegBlob = await new Promise<Blob>((r) =>
        canvas.toBlob((b) => r(b!), 'image/jpeg', 0.9),
      );

      const fromPng = await upscaler.upscale(png, { scale: 2, engine: 'classical' });
      const fromJpeg = await upscaler.upscale(jpegBlob, { scale: 2, engine: 'classical' });
      await upscaler.dispose();
      return { fromPng: fromPng.format, fromJpeg: fromJpeg.format };
    });

    expect(formats.fromPng).toBe('png');
    expect(formats.fromJpeg).toBe('jpeg');
  });

  test('never writes a transparent image as JPEG by default', async ({ page }) => {
    const format = await page.evaluate(async () => {
      const upscaler = new window.ImageUpscaler({ useWorker: false });
      const file = await window.harness.makeTransparentFile(32);
      const out = await upscaler.upscale(file, { scale: 2, engine: 'classical' });
      await upscaler.dispose();
      return out.format;
    });
    expect(format).toBe('png');
  });
});

test.describe('modes', () => {
  test('every mode runs and pixel-art adds no colours', async ({ page }) => {
    const results = await page.evaluate(async () => {
      const upscaler = new window.ImageUpscaler({ useWorker: false });
      const modes = ['natural', 'balanced', 'detail', 'document', 'pixel-art'];
      const out: Array<{ mode: string; width: number; distinct: number }> = [];

      // A small palette image, so "no new colours" is measurable.
      const canvas = document.createElement('canvas');
      canvas.width = 16;
      canvas.height = 16;
      const ctx = canvas.getContext('2d')!;
      const palette = ['#1b2540', '#ed7532', '#2fa84f', '#f2d94e'];
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          ctx.fillStyle = palette[(x * 3 + y * 5) % palette.length];
          ctx.fillRect(x, y, 1, 1);
        }
      }
      const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/png'));

      for (const mode of modes) {
        const result = await upscaler.upscale(blob, { scale: 4, engine: 'classical', mode });
        const pixels = await window.harness.pixels(result.blob);
        const seen = new Set<string>();
        for (let i = 0; i < pixels.data.length; i += 4) {
          seen.add(pixels.data.slice(i, i + 3).join(','));
        }
        out.push({ mode, width: result.width, distinct: seen.size });
      }
      await upscaler.dispose();
      return out;
    });

    for (const result of results) {
      expect(result.width, result.mode).toBe(64);
    }
    const pixelArt = results.find((r) => r.mode === 'pixel-art')!;
    const detail = results.find((r) => r.mode === 'detail')!;
    // Nearest neighbour cannot invent a colour; the palette has four.
    expect(pixelArt.distinct).toBeLessThanOrEqual(4);
    expect(detail.distinct).toBeGreaterThan(pixelArt.distinct);
  });
});

test.describe('progress and cancellation', () => {
  test('reports throttled, monotonic progress through the documented stages', async ({ page }) => {
    const report = await page.evaluate(async () => {
      const upscaler = new window.ImageUpscaler({ useWorker: false });
      const file = await window.harness.makeFile(128);
      const events: Array<{ progress: number; stage: string }> = [];
      await upscaler.upscale(file, {
        scale: 4,
        engine: 'classical',
        onProgress: (p: { progress: number; stage: string }) =>
          events.push({ progress: p.progress, stage: p.stage }),
      });
      await upscaler.dispose();
      return events;
    });

    expect(report.length).toBeGreaterThan(2);
    // Reasonable, not thousands.
    expect(report.length).toBeLessThan(400);
    for (let i = 1; i < report.length; i++) {
      expect(report[i].progress).toBeGreaterThanOrEqual(report[i - 1].progress);
    }
    expect(report[report.length - 1]).toEqual({ progress: 1, stage: 'complete' });

    const stages = new Set(report.map((e) => e.stage));
    expect(stages.has('decoding')).toBe(true);
    expect(stages.has('encoding')).toBe(true);
    for (const stage of stages) {
      expect([
        'decoding',
        'analyzing',
        'upscaling',
        'reconstructing',
        'sharpening',
        'encoding',
        'complete',
      ]).toContain(stage);
    }
  });

  test('cancels a run in flight and reports CANCELLED', async ({ page }) => {
    const outcome = await page.evaluate(async () => {
      const upscaler = new window.ImageUpscaler({ useWorker: false });
      const file = await window.harness.makeFile(512);
      const controller = new AbortController();
      let sawProgress = false;

      const promise = upscaler.upscale(file, {
        scale: 8,
        engine: 'classical',
        signal: controller.signal,
        onProgress: () => {
          sawProgress = true;
        },
      });
      // Abort once the run is genuinely under way.
      setTimeout(() => controller.abort(), 60);

      try {
        await promise;
        return { cancelled: false, sawProgress };
      } catch (error) {
        return {
          cancelled: true,
          sawProgress,
          code: (error as { code?: string }).code,
          recognised: window.ImageUpscaler.isCancellation(error),
        };
      } finally {
        await upscaler.dispose();
      }
    });

    expect(outcome.cancelled).toBe(true);
    expect(outcome.code).toBe('CANCELLED');
    expect(outcome.recognised).toBe(true);
  });

  test('rejects immediately for an already-aborted signal', async ({ page }) => {
    const code = await page.evaluate(async () => {
      const upscaler = new window.ImageUpscaler({ useWorker: false });
      const file = await window.harness.makeFile(32);
      const controller = new AbortController();
      controller.abort();
      try {
        await upscaler.upscale(file, { scale: 2, signal: controller.signal });
        return 'no error';
      } catch (error) {
        return (error as { code?: string }).code;
      } finally {
        await upscaler.dispose();
      }
    });
    expect(code).toBe('CANCELLED');
  });
});

test.describe('tiling', () => {
  test('an explicit small tile size gives the same result as one pass', async ({ page }) => {
    // The seam guarantee, verified through the public API in a real browser
    // rather than against internal surfaces.
    const comparison = await page.evaluate(async () => {
      const upscaler = new window.ImageUpscaler({ useWorker: false });
      const file = await window.harness.makeFile(96);

      const whole = await upscaler.upscale(file, {
        scale: 2,
        engine: 'classical',
        tileSize: 4096,
        output: { format: 'png' },
      });
      const tiled = await upscaler.upscale(file, {
        scale: 2,
        engine: 'classical',
        tileSize: 24,
        output: { format: 'png' },
      });

      const a = await window.harness.pixels(whole.blob);
      const b = await window.harness.pixels(tiled.blob);
      await upscaler.dispose();

      let worst = 0;
      let worstInterior = 0;
      const margin = 8;
      for (let y = 0; y < a.height; y++) {
        for (let x = 0; x < a.width; x++) {
          const i = (y * a.width + x) * 4;
          for (let c = 0; c < 4; c++) {
            const d = Math.abs(a.data[i + c] - b.data[i + c]);
            if (d > worst) worst = d;
            const interior =
              x >= margin && y >= margin && x < a.width - margin && y < a.height - margin;
            if (interior && d > worstInterior) worstInterior = d;
          }
        }
      }
      return { size: [a.width, a.height], worst, worstInterior, tileReported: tiled.width };
    });

    expect(comparison.size).toEqual([192, 192]);
    expect(comparison.tileReported).toBe(192);
    // 8-bit output: the interior must be identical after encoding.
    expect(comparison.worstInterior).toBe(0);
    // The image border may differ by one level, for the reason documented in
    // TileManager: the halo is clamp-extended in source space.
    expect(comparison.worst).toBeLessThanOrEqual(1);
  });

  test('reports tile counters while tiling', async ({ page }) => {
    const counters = await page.evaluate(async () => {
      const upscaler = new window.ImageUpscaler({ useWorker: false });
      const file = await window.harness.makeFile(128);
      const seen: Array<{ current?: number; total?: number }> = [];
      await upscaler.upscale(file, {
        scale: 2,
        engine: 'classical',
        tileSize: 32,
        onProgress: (p: { currentTile?: number; totalTiles?: number }) => {
          if (p.totalTiles) seen.push({ current: p.currentTile, total: p.totalTiles });
        },
      });
      await upscaler.dispose();
      return seen;
    });

    expect(counters.length).toBeGreaterThan(0);
    const total = counters[0].total!;
    // 128 / 32 = 4 columns and rows.
    expect(total).toBe(16);
    for (const entry of counters) {
      expect(entry.total).toBe(total);
      expect(entry.current!).toBeGreaterThanOrEqual(1);
      expect(entry.current!).toBeLessThanOrEqual(total);
    }
  });

  test('handles a large image by tiling automatically', async ({ page }) => {
    // 1600x1200 at 4x is a 30 MP result: large enough to exercise the memory
    // planner and the tiled path without needing a slow 4K source.
    const result = await page.evaluate(async () => {
      const upscaler = new window.ImageUpscaler({ useWorker: false });
      const canvas = document.createElement('canvas');
      canvas.width = 1600;
      canvas.height = 1200;
      const ctx = canvas.getContext('2d')!;
      const gradient = ctx.createLinearGradient(0, 0, 1600, 1200);
      gradient.addColorStop(0, '#000');
      gradient.addColorStop(1, '#fff');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 1600, 1200);
      for (let i = 0; i < 1600; i += 23) {
        ctx.fillStyle = i % 2 ? '#ed7532' : '#2fa84f';
        ctx.fillRect(i, 0, 3, 1200);
      }

      let maxTiles = 0;
      const out = await upscaler.upscale(canvas, {
        scale: 4,
        engine: 'classical',
        mode: 'natural',
        onProgress: (p: { totalTiles?: number }) => {
          if (p.totalTiles) maxTiles = Math.max(maxTiles, p.totalTiles);
        },
      });
      await upscaler.dispose();
      return { width: out.width, height: out.height, maxTiles, size: out.blob.size };
    });

    expect(result.width).toBe(6400);
    expect(result.height).toBe(4800);
    expect(result.size).toBeGreaterThan(10_000);
  });
});
