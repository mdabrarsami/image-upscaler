import { UpscalerError } from '../core/errors.js';

/**
 * Environment adapters.
 *
 * The processing core is pure numerics on typed arrays and never touches a
 * browser API. Everything that does - canvases, bitmaps, blobs - goes through
 * this module, which probes for whichever variant the current host provides.
 * That is what lets the same code run on the main thread, inside a Worker
 * (where `document` does not exist), and in Electron's renderer.
 *
 * Deliberately small: only the handful of APIs whose shape actually differs
 * between hosts is abstracted. A general-purpose "platform layer" would be
 * mostly indirection.
 */

export type EnvironmentKind = 'browser' | 'worker' | 'node' | 'unknown';

export function detectEnvironment(): EnvironmentKind {
  if (typeof window !== 'undefined' && typeof document !== 'undefined') return 'browser';
  if (
    typeof self !== 'undefined' &&
    typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined'
  ) {
    return 'worker';
  }
  // Referenced through globalThis so the core never needs @types/node.
  const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
  if (proc?.versions?.node) return 'node';
  return 'unknown';
}

export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
export type AnyCanvas2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function hasOffscreenCanvas(): boolean {
  return typeof OffscreenCanvas !== 'undefined';
}

export function hasDocument(): boolean {
  return typeof document !== 'undefined';
}

/**
 * Create a drawing surface. `OffscreenCanvas` is preferred everywhere it
 * exists: it works in Workers and avoids attaching a node to the document.
 */
export function createCanvas(width: number, height: number): AnyCanvas {
  if (hasOffscreenCanvas()) return new OffscreenCanvas(width, height);
  if (hasDocument()) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  throw new UpscalerError(
    'RUNTIME_UNAVAILABLE',
    'No canvas implementation is available in this environment',
  );
}

export function get2DContext(canvas: AnyCanvas, willReadFrequently = true): AnyCanvas2D {
  const ctx = canvas.getContext('2d', { willReadFrequently }) as AnyCanvas2D | null;
  if (!ctx) {
    throw new UpscalerError('RUNTIME_UNAVAILABLE', 'Could not acquire a 2D canvas context');
  }
  return ctx;
}

/** Turn a canvas into a Blob, whichever API this host exposes. */
export async function canvasToBlob(
  canvas: AnyCanvas,
  mimeType: string,
  quality?: number,
): Promise<Blob> {
  if ('convertToBlob' in canvas) {
    return canvas.convertToBlob(quality === undefined ? { type: mimeType } : { type: mimeType, quality });
  }
  return new Promise<Blob>((resolve, reject) => {
    (canvas as HTMLCanvasElement).toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new UpscalerError('ENCODING_FAILED', `Canvas could not encode ${mimeType}`));
      },
      mimeType,
      quality,
    );
  });
}

export function hasCreateImageBitmap(): boolean {
  return typeof createImageBitmap === 'function';
}

/** True when this host can construct a Worker from a module URL. */
export function supportsWorkers(): boolean {
  return typeof Worker !== 'undefined';
}

export function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * Yield to the event loop. Between tiles this is what keeps the main thread
 * from being wedged when workers are unavailable, and it also gives an
 * `AbortSignal` a chance to fire.
 */
export function yieldToEventLoop(): Promise<void> {
  if (typeof setTimeout === 'function') {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
  return Promise.resolve();
}
