import type { Capabilities, OutputFormat } from '../core/types.js';
import { estimateMemoryBudget } from '../memory/MemoryManager.js';

/**
 * Feature detection.
 *
 * Everything here is probed rather than inferred from the user agent, and the
 * result is cached: adapter requests and canvas allocations are not free, and
 * capabilities do not change during a page's lifetime. `refresh: true` is
 * available for the one case that does change - a GPU that gets lost.
 */

let cached: Promise<Capabilities> | undefined;

export interface DetectOptions {
  /** Re-probe instead of returning the cached result. */
  refresh?: boolean;
}

export async function detectCapabilities(options: DetectOptions = {}): Promise<Capabilities> {
  if (options.refresh) cached = undefined;
  cached ??= probe();
  return cached;
}

/** Synchronous subset, for code paths that cannot await. */
export function detectCapabilitiesSync(): Omit<Capabilities, 'webGPU' | 'maxBufferSize'> {
  const memory = estimateMemoryBudget();
  const gl = probeWebGL();
  return {
    webGL: gl.webGL,
    webGL2: gl.webGL2,
    maxTextureSize: gl.maxTextureSize,
    offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
    workers: typeof Worker !== 'undefined',
    wasm: typeof WebAssembly !== 'undefined',
    wasmSimd: probeWasmSimd(),
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    createImageBitmap: typeof createImageBitmap === 'function',
    indexedDB: typeof indexedDB !== 'undefined',
    estimatedMemory: memory.budget,
    estimatedMemoryIsReported: memory.reported,
    encodableFormats: probeEncodableFormats(),
    hardwareConcurrency:
      typeof navigator !== 'undefined' && navigator.hardwareConcurrency
        ? navigator.hardwareConcurrency
        : 4,
  };
}

async function probe(): Promise<Capabilities> {
  const sync = detectCapabilitiesSync();
  const gpu = await probeWebGPU();
  return {
    ...sync,
    webGPU: gpu.available,
    maxBufferSize: gpu.maxBufferSize,
    maxTextureSize: gpu.maxTextureSize ?? sync.maxTextureSize,
  };
}

interface WebGPUProbe {
  available: boolean;
  maxBufferSize: number | null;
  maxTextureSize: number | null;
}

async function probeWebGPU(): Promise<WebGPUProbe> {
  const nav = globalThis.navigator as (Navigator & { gpu?: GPU }) | undefined;
  if (!nav?.gpu) return { available: false, maxBufferSize: null, maxTextureSize: null };
  try {
    const adapter = await nav.gpu.requestAdapter();
    if (!adapter) return { available: false, maxBufferSize: null, maxTextureSize: null };
    const limits = adapter.limits;
    return {
      available: true,
      maxBufferSize: Number(limits.maxStorageBufferBindingSize ?? 0) || null,
      maxTextureSize: limits.maxTextureDimension2D ?? null,
    };
  } catch {
    // An adapter request can reject on a machine with a blocklisted driver.
    return { available: false, maxBufferSize: null, maxTextureSize: null };
  }
}

interface WebGLProbe {
  webGL: boolean;
  webGL2: boolean;
  maxTextureSize: number | null;
}

function probeWebGL(): WebGLProbe {
  const makeCanvas = (): HTMLCanvasElement | OffscreenCanvas | null => {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(1, 1);
    if (typeof document !== 'undefined') return document.createElement('canvas');
    return null;
  };
  const canvas = makeCanvas();
  if (!canvas) return { webGL: false, webGL2: false, maxTextureSize: null };

  let gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
  let webGL2 = false;
  try {
    gl = canvas.getContext('webgl2') as WebGL2RenderingContext | null;
    webGL2 = gl !== null;
    if (!gl) gl = canvas.getContext('webgl') as WebGLRenderingContext | null;
  } catch {
    gl = null;
  }
  if (!gl) return { webGL: false, webGL2: false, maxTextureSize: null };

  const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  // Release the context eagerly; browsers cap the number of live GL contexts
  // and a probe should not consume one of them.
  const lose = gl.getExtension('WEBGL_lose_context');
  lose?.loseContext();
  return { webGL: true, webGL2, maxTextureSize };
}

/**
 * The canonical SIMD probe: a four-byte module whose body uses `v128.const`.
 * Runtimes without SIMD fail validation.
 */
function probeWasmSimd(): boolean {
  if (typeof WebAssembly === 'undefined') return false;
  try {
    return WebAssembly.validate(
      new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0,
        253, 15, 253, 98, 11,
      ]),
    );
  } catch {
    return false;
  }
}

const ALL_FORMATS: OutputFormat[] = ['png', 'jpeg', 'webp'];

/**
 * Canvas encoders vary: WebP is missing on older Safari, and a canvas that
 * cannot honour a MIME type silently falls back to PNG rather than failing.
 * `toDataURL` prefix matching is the only reliable synchronous check.
 */
function probeEncodableFormats(): OutputFormat[] {
  if (typeof document === 'undefined') {
    // In a worker, assume the two universally supported formats and let the
    // encoder discover WebP support on first use.
    return ['png', 'jpeg'];
  }
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  return ALL_FORMATS.filter((format) => {
    const mime = `image/${format}`;
    try {
      return canvas.toDataURL(mime).startsWith(`data:${mime}`);
    } catch {
      return false;
    }
  });
}
