import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUILTIN_MODELS,
  ModelRegistry,
} from '../../packages/image-upscaler/src/ai/ModelRegistry.js';
import {
  downloadModel,
  sha256Hex,
} from '../../packages/image-upscaler/src/ai/ModelDownloader.js';
import { ModelManager } from '../../packages/image-upscaler/src/ai/ModelManager.js';
import { ModelCache } from '../../packages/image-upscaler/src/ai/ModelCache.js';
import {
  nchwToSurface,
  surfaceToNCHW,
} from '../../packages/image-upscaler/src/ai/AIInference.js';
import type { UpscalerError } from '../../packages/image-upscaler/src/core/errors.js';
import type { ModelDefinition } from '../../packages/image-upscaler/src/core/types.js';
import { createSurface } from '../../packages/image-upscaler/src/image/surface.js';
import { gradient, solid } from '../fixtures/synthetic.js';

const VALID: ModelDefinition = {
  id: 'test-model',
  name: 'Test Model',
  scale: 2,
  size: 1024,
  version: '1.0.0',
  license: 'MIT',
  source: 'https://example.com/repo',
  url: 'https://example.com/model.onnx',
  sha256: 'a'.repeat(64),
};

describe('built-in catalogue', () => {
  it('is not empty and every entry is complete', () => {
    expect(BUILTIN_MODELS.length).toBeGreaterThan(0);
    for (const model of BUILTIN_MODELS) {
      expect(model.id, 'id').toBeTruthy();
      expect(model.url.startsWith('https://'), `${model.id} url`).toBe(true);
      expect(model.size, `${model.id} size`).toBeGreaterThan(0);
      expect(model.license, `${model.id} license`).toBeTruthy();
      expect(model.source, `${model.id} source`).toBeTruthy();
    }
  });

  it('ships a checksum and an attribution for every model', () => {
    // Both are load-bearing: the checksum is the only defence against a
    // tampered or truncated download, and the attribution is a licence
    // obligation, not decoration.
    for (const model of BUILTIN_MODELS) {
      expect(model.sha256, `${model.id} sha256`).toMatch(/^[0-9a-f]{64}$/);
      expect(model.attribution, `${model.id} attribution`).toBeTruthy();
    }
  });

  it('is frozen, so one consumer cannot mutate the catalogue for another', () => {
    expect(Object.isFrozen(BUILTIN_MODELS)).toBe(true);
    expect(() => {
      (BUILTIN_MODELS as unknown as ModelDefinition[]).push(VALID);
    }).toThrow();
  });

  it('covers 2x and 4x natively', () => {
    const scales = BUILTIN_MODELS.map((m) => m.scale);
    expect(scales).toContain(2);
    expect(scales).toContain(4);
  });
});

describe('ModelRegistry', () => {
  it('registers and retrieves a model', () => {
    const registry = new ModelRegistry([]);
    registry.register(VALID);
    expect(registry.has('test-model')).toBe(true);
    expect(registry.get('test-model').name).toBe('Test Model');
    expect(registry.ids()).toEqual(['test-model']);
  });

  it('applies defaults for the optional fields', () => {
    const registry = new ModelRegistry([]);
    const resolved = registry.register(VALID);
    expect(resolved.channels).toBe(3);
    expect(resolved.layout).toBe('nchw');
    expect(resolved.inputRange).toEqual([0, 1]);
    expect(resolved.preferredTileSize).toBeGreaterThan(0);
    expect(resolved.tileOverlap).toBeGreaterThan(0);
  });

  it('does not let an explicit undefined clobber a default', () => {
    const registry = new ModelRegistry([]);
    const resolved = registry.register({ ...VALID, channels: undefined, tileOverlap: undefined });
    expect(resolved.channels).toBe(3);
    expect(resolved.tileOverlap).toBeGreaterThan(0);
  });

  it('throws MODEL_NOT_FOUND with the list of what is available', () => {
    const registry = new ModelRegistry([]);
    registry.register(VALID);
    try {
      registry.get('nope');
      expect.unreachable('should have thrown');
    } catch (error) {
      const e = error as UpscalerError;
      expect(e.code).toBe('MODEL_NOT_FOUND');
      expect(e.details?.available).toEqual(['test-model']);
    }
  });

  it('replaces an existing registration with the same id', () => {
    const registry = new ModelRegistry([]);
    registry.register(VALID);
    registry.register({ ...VALID, name: 'Replaced' });
    expect(registry.all()).toHaveLength(1);
    expect(registry.get('test-model').name).toBe('Replaced');
  });

  it('unregisters', () => {
    const registry = new ModelRegistry([VALID]);
    expect(registry.unregister('test-model')).toBe(true);
    expect(registry.unregister('test-model')).toBe(false);
    expect(registry.has('test-model')).toBe(false);
  });

  describe('validation', () => {
    const invalid: Array<[string, Partial<ModelDefinition>, RegExp]> = [
      ['missing id', { id: '' }, /id must be a non-empty string/],
      ['missing url', { url: '' }, /url must be a non-empty string/],
      ['zero scale', { scale: 0 }, /scale must be >= 1/],
      ['zero size', { size: 0 }, /size must be > 0/],
      ['missing licence', { license: '' }, /license is required/],
      ['plain http', { url: 'http://evil.example.com/m.onnx' }, /must use https/],
      ['bad checksum', { sha256: 'not-a-hash' }, /64 lowercase hex/],
      ['uppercase checksum', { sha256: 'A'.repeat(64) }, /64 lowercase hex/],
      ['unknown layout', { layout: 'nhwc' as 'nchw' }, /unsupported tensor layout/],
      ['bad channels', { channels: 2 as 3 }, /channels must be 3 or 4/],
      ['a non-web protocol', { url: 'ftp://example.com/m.onnx' }, /must use https/],
      ['a data URL', { url: 'data:application/octet-stream;base64,AAAA' }, /must use https/],
    ];

    for (const [label, patch, pattern] of invalid) {
      it(`rejects ${label}`, () => {
        const registry = new ModelRegistry([]);
        expect(() => registry.register({ ...VALID, ...patch })).toThrow(pattern);
      });
    }

    it('reports INVALID_OPTIONS with the full problem list', () => {
      const registry = new ModelRegistry([]);
      try {
        registry.register({ ...VALID, id: '', license: '', size: -1 });
        expect.unreachable('should have thrown');
      } catch (error) {
        const e = error as UpscalerError;
        expect(e.code).toBe('INVALID_OPTIONS');
        expect((e.details?.problems as string[]).length).toBeGreaterThanOrEqual(3);
      }
    });

    it('allows http on localhost, for local development', () => {
      const registry = new ModelRegistry([]);
      expect(() =>
        registry.register({ ...VALID, url: 'http://localhost:8080/model.onnx' }),
      ).not.toThrow();
      expect(() =>
        registry.register({ ...VALID, id: 'b', url: 'http://127.0.0.1:8080/model.onnx' }),
      ).not.toThrow();
    });

    it('allows a relative path, for a model served from the same origin', () => {
      // Resolved against the document base, so it inherits the page's origin
      // and its transport security along with it.
      const registry = new ModelRegistry([]);
      expect(() => registry.register({ ...VALID, url: '/models/upscaler-x4.onnx' })).not.toThrow();
      expect(() =>
        registry.register({ ...VALID, id: 'rel', url: './models/upscaler-x4.onnx' }),
      ).not.toThrow();
    });

    it('allows a blob URL, for a model supplied from memory', () => {
      const registry = new ModelRegistry([]);
      expect(() =>
        registry.register({ ...VALID, url: 'blob:https://example.com/abc-123' }),
      ).not.toThrow();
    });
  });

  describe('scale matching', () => {
    const registry = new ModelRegistry(BUILTIN_MODELS);

    it('prefers an exact match', () => {
      expect(registry.findForScale(4)?.scale).toBe(4);
      expect(registry.findForScale(2)?.scale).toBe(2);
    });

    it('picks the largest clean divisor when there is no exact match', () => {
      // 8x has no native model, but 4x divides it, and one pass of the 4x
      // network beats two passes of the 2x one.
      expect(registry.findForScale(8)?.scale).toBe(4);
    });

    it('falls back to the largest model no bigger than the request', () => {
      expect(registry.findForScale(3)?.scale).toBe(2);
    });

    it('returns undefined for an empty catalogue', () => {
      expect(new ModelRegistry([]).findForScale(4)).toBeUndefined();
    });
  });
});

describe('ModelDownloader', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  /** A response whose body streams in `chunks`. */
  function streamingResponse(chunks: Uint8Array[], declareLength = true): Response {
    const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < chunks.length) controller.enqueue(chunks[index++]);
        else controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: declareLength ? { 'content-length': String(total) } : {},
    });
  }

  async function modelFor(bytes: Uint8Array, overrides: Partial<ModelDefinition> = {}) {
    const sha256 = await sha256Hex(bytes.buffer.slice(0) as ArrayBuffer);
    return new ModelRegistry([]).register({ ...VALID, size: bytes.byteLength, sha256, ...overrides });
  }

  it('computes SHA-256 the same way the reference tools do', async () => {
    // "abc" has a famously well-known digest; a wrong endianness or encoding
    // would show up immediately here.
    const bytes = new TextEncoder().encode('abc');
    expect(await sha256Hex(bytes.buffer as ArrayBuffer)).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('downloads, verifies, and reports progress', async () => {
    const bytes = new Uint8Array(3000).fill(7);
    const model = await modelFor(bytes);
    globalThis.fetch = vi.fn(async () =>
      streamingResponse([bytes.slice(0, 1000), bytes.slice(1000, 2000), bytes.slice(2000)]),
    ) as typeof fetch;

    const events: number[] = [];
    const result = await downloadModel(model, {
      onProgress: (p) => {
        if (p.progress !== null) events.push(p.progress);
      },
    });

    expect(new Uint8Array(result.bytes)).toEqual(bytes);
    expect(result.sha256).toBe(model.sha256);
    expect(events.at(-1)).toBe(1);
  });

  it('reports a null progress fraction when the server omits content-length', async () => {
    const bytes = new Uint8Array(500).fill(1);
    const model = await modelFor(bytes);
    globalThis.fetch = vi.fn(async () => streamingResponse([bytes], false)) as typeof fetch;

    const seen: Array<number | null> = [];
    await downloadModel(model, { onProgress: (p) => seen.push(p.progress) });
    expect(seen.every((v) => v === null)).toBe(true);
  });

  it('rejects a checksum mismatch as MODEL_CORRUPTED', async () => {
    const bytes = new Uint8Array(100).fill(3);
    const model = await modelFor(bytes, { sha256: 'b'.repeat(64) });
    globalThis.fetch = vi.fn(async () => streamingResponse([bytes])) as typeof fetch;

    try {
      await downloadModel(model, { retries: 0 });
      expect.unreachable('should have thrown');
    } catch (error) {
      const e = error as UpscalerError;
      expect(e.code).toBe('MODEL_CORRUPTED');
      expect(e.details?.expected).toBe('b'.repeat(64));
      expect(e.details?.actual).toBe(await sha256Hex(bytes.buffer.slice(0) as ArrayBuffer));
    }
  });

  it('detects a truncated body that still returned 200', async () => {
    // Flaky proxies do exactly this, and the failure would otherwise surface
    // as an unintelligible ONNX parse error.
    const bytes = new Uint8Array(1000).fill(9);
    const model = await modelFor(bytes);
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(bytes.slice(0, 400));
              controller.close();
            },
          }),
          { status: 200, headers: { 'content-length': '1000' } },
        ),
    ) as typeof fetch;

    try {
      await downloadModel(model, { retries: 0 });
      expect.unreachable('should have thrown');
    } catch (error) {
      const e = error as UpscalerError;
      expect(e.code).toBe('MODEL_DOWNLOAD_FAILED');
      expect(e.message).toMatch(/Truncated/);
      expect(e.details).toMatchObject({ loaded: 400, total: 1000 });
    }
  });

  it('turns an HTTP error into MODEL_DOWNLOAD_FAILED with the status', async () => {
    const model = await modelFor(new Uint8Array(10));
    globalThis.fetch = vi.fn(
      async () => new Response('nope', { status: 404, statusText: 'Not Found' }),
    ) as typeof fetch;

    try {
      await downloadModel(model, { retries: 0 });
      expect.unreachable('should have thrown');
    } catch (error) {
      const e = error as UpscalerError;
      expect(e.code).toBe('MODEL_DOWNLOAD_FAILED');
      expect(e.details?.status).toBe(404);
    }
  });

  it('retries a transient network failure and then succeeds', async () => {
    const bytes = new Uint8Array(200).fill(5);
    const model = await modelFor(bytes);
    let attempts = 0;
    globalThis.fetch = vi.fn(async () => {
      attempts++;
      if (attempts < 3) throw new TypeError('network down');
      return streamingResponse([bytes]);
    }) as typeof fetch;

    const result = await downloadModel(model, { retries: 2 });
    expect(attempts).toBe(3);
    expect(result.sha256).toBe(model.sha256);
  });

  it('gives up after the retry budget', async () => {
    const model = await modelFor(new Uint8Array(10));
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('network down');
    }) as typeof fetch;

    await expect(downloadModel(model, { retries: 1 })).rejects.toMatchObject({
      code: 'MODEL_DOWNLOAD_FAILED',
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('aborts promptly and does not retry', async () => {
    const model = await modelFor(new Uint8Array(10));
    const controller = new AbortController();
    globalThis.fetch = vi.fn(async () => {
      controller.abort();
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }) as typeof fetch;

    await expect(
      downloadModel(model, { signal: controller.signal, retries: 3 }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses to start when the signal is already aborted', async () => {
    const model = await modelFor(new Uint8Array(10));
    const controller = new AbortController();
    controller.abort();
    globalThis.fetch = vi.fn() as typeof fetch;
    await expect(
      downloadModel(model, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('ModelManager without storage', () => {
  // Node has no IndexedDB. The manager has to degrade to "nothing is
  // installed" rather than throwing, because that is also what a
  // private-browsing window looks like.
  beforeEach(() => {
    expect(ModelCache.isAvailable()).toBe(false);
  });

  it('lists the catalogue with everything marked uninstalled', async () => {
    const manager = new ModelManager();
    const models = await manager.list();
    expect(models.length).toBe(BUILTIN_MODELS.length);
    for (const model of models) expect(model.installed).toBe(false);
  });

  it('surfaces licence and attribution through the public list', async () => {
    const models = await new ModelManager().list();
    for (const model of models) {
      expect(model.license).toBeTruthy();
      expect(model.source).toBeTruthy();
    }
  });

  it('reports isInstalled false and delete false', async () => {
    const manager = new ModelManager();
    await expect(manager.isInstalled('realesrgan-x4')).resolves.toBe(false);
    await expect(manager.delete('realesrgan-x4')).resolves.toBe(false);
    await expect(manager.usage()).resolves.toBe(0);
  });

  it('rejects an unknown id from isInstalled', async () => {
    await expect(new ModelManager().isInstalled('nope')).rejects.toMatchObject({
      code: 'MODEL_NOT_FOUND',
    });
  });

  it('accepts a custom registration through the public API', async () => {
    const manager = new ModelManager();
    manager.register({ ...VALID, id: 'custom-x2' });
    const ids = (await manager.list()).map((m) => m.id);
    expect(ids).toContain('custom-x2');
  });

  it('rejects a custom registration that fails validation', () => {
    const manager = new ModelManager();
    expect(() => manager.register({ ...VALID, url: 'http://evil.test/m.onnx' })).toThrow(
      /must use https/,
    );
  });
});

describe('tensor conversion', () => {
  it('interleaved RGBA to planar NCHW, dropping alpha for a 3-channel model', () => {
    const surface = createSurface(2, 2);
    surface.data.set([
      0.1, 0.2, 0.3, 1, //
      0.4, 0.5, 0.6, 1,
      0.7, 0.8, 0.9, 1,
      1.0, 0.0, 0.5, 1,
    ]);
    const tensor = surfaceToNCHW(surface, 3);
    expect(tensor.length).toBe(3 * 4);
    // Plane 0 is every red value in row-major order.
    expect(Array.from(tensor.slice(0, 4)).map(round2)).toEqual([0.1, 0.4, 0.7, 1]);
    expect(Array.from(tensor.slice(4, 8)).map(round2)).toEqual([0.2, 0.5, 0.8, 0]);
    expect(Array.from(tensor.slice(8, 12)).map(round2)).toEqual([0.3, 0.6, 0.9, 0.5]);
  });

  it('keeps alpha for a 4-channel model', () => {
    const surface = solid(2, 2, [0.2, 0.4, 0.6, 0.8]);
    const tensor = surfaceToNCHW(surface, 4);
    expect(tensor.length).toBe(4 * 4);
    expect(round2(tensor[12])).toBe(0.8);
  });

  it('round-trips through NCHW and back', () => {
    const original = gradient(8, 4);
    const tensor = surfaceToNCHW(original, 3);
    const back = nchwToSurface({ data: tensor, dims: [1, 3, 4, 8] });
    expect(back.width).toBe(8);
    expect(back.height).toBe(4);
    for (let i = 0; i < back.data.length; i += 4) {
      expect(back.data[i]).toBeCloseTo(original.data[i], 6);
      // Alpha is filled opaque, since a 3-channel model produces none.
      expect(back.data[i + 3]).toBe(1);
    }
  });

  it('maps a non-unit input range', () => {
    const surface = solid(1, 1, [0, 0.5, 1, 1]);
    const tensor = surfaceToNCHW(surface, 3, [-1, 1]);
    expect(round2(tensor[0])).toBe(-1);
    expect(round2(tensor[1])).toBe(0);
    expect(round2(tensor[2])).toBe(1);

    const back = nchwToSurface({ data: tensor, dims: [1, 3, 1, 1] }, [-1, 1]);
    expect(round2(back.data[0])).toBe(0);
    expect(round2(back.data[1])).toBe(0.5);
    expect(round2(back.data[2])).toBe(1);
  });

  it('clamps network output into the displayable range', () => {
    // A GAN routinely produces values slightly outside [0, 1]; those must not
    // wrap or produce NaN downstream.
    const tensor = new Float32Array([-0.5, 2, 0.5, -0.5, 2, 0.5, -0.5, 2, 0.5]);
    const back = nchwToSurface({ data: tensor, dims: [1, 3, 1, 3] });
    for (let i = 0; i < back.data.length; i++) {
      expect(back.data[i]).toBeGreaterThanOrEqual(0);
      expect(back.data[i]).toBeLessThanOrEqual(1);
    }
  });

  it('rejects a tensor that is not 4-D', () => {
    expect(() => nchwToSurface({ data: new Float32Array(3), dims: [3] })).toThrow(
      /4-D NCHW/,
    );
  });

  it('rejects an unsupported channel count', () => {
    expect(() =>
      nchwToSurface({ data: new Float32Array(2), dims: [1, 2, 1, 1] }),
    ).toThrow(/channel count/);
  });
});

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
