import { UpscalerError } from '../core/errors.js';

export type SurfaceColorSpace = 'srgb' | 'linear';

/**
 * The internal pixel container. Interleaved RGBA, one `Float32` per channel,
 * nominal range 0..1. Float is deliberate: every filter in the pipeline is
 * multi-pass, and 8-bit intermediates visibly band after two or three passes.
 */
export interface Surface {
  data: Float32Array;
  width: number;
  height: number;
  colorSpace: SurfaceColorSpace;
  /** True when RGB has already been multiplied by A. */
  premultiplied: boolean;
}

export const CHANNELS = 4;

export function createSurface(
  width: number,
  height: number,
  colorSpace: SurfaceColorSpace = 'srgb',
  premultiplied = false,
): Surface {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new UpscalerError('INVALID_INPUT', `Invalid surface size ${width}x${height}`);
  }
  const count = width * height * CHANNELS;
  // 4 bytes per float; guard before the allocator does it for us with a
  // less useful message.
  if (count > 0x7fffffff / 4) {
    throw new UpscalerError('IMAGE_TOO_LARGE', `Surface ${width}x${height} exceeds addressable memory`, {
      details: { width, height },
    });
  }
  let data: Float32Array;
  try {
    data = new Float32Array(count);
  } catch (cause) {
    throw new UpscalerError('OUT_OF_MEMORY', `Could not allocate ${width}x${height} surface`, { cause });
  }
  return { data, width, height, colorSpace, premultiplied };
}

export function cloneSurface(surface: Surface): Surface {
  return {
    data: new Float32Array(surface.data),
    width: surface.width,
    height: surface.height,
    colorSpace: surface.colorSpace,
    premultiplied: surface.premultiplied,
  };
}

/** A surface with the same geometry and colour state but zeroed pixels. */
export function likeSurface(surface: Surface): Surface {
  return createSurface(surface.width, surface.height, surface.colorSpace, surface.premultiplied);
}

export function surfaceFromImageData(image: ImageData): Surface {
  const surface = createSurface(image.width, image.height, 'srgb', false);
  const src = image.data;
  const dst = surface.data;
  for (let i = 0; i < src.length; i++) dst[i] = src[i] / 255;
  return surface;
}

export function surfaceToUint8(surface: Surface): Uint8ClampedArray {
  const out = new Uint8ClampedArray(surface.width * surface.height * CHANNELS);
  const src = surface.data;
  for (let i = 0; i < out.length; i++) {
    // +0.5 then truncate via the clamped array's own rounding.
    out[i] = src[i] * 255;
  }
  return out;
}

/** Byte cost of a surface, useful for memory planning. */
export function surfaceBytes(width: number, height: number): number {
  return width * height * CHANNELS * 4;
}

/** Index of the first channel of pixel (x, y). Caller must keep x/y in range. */
export function index(surface: Pick<Surface, 'width'>, x: number, y: number): number {
  return (y * surface.width + x) * CHANNELS;
}

/** Clamped ("clamp to edge") sample index. */
export function clampedIndex(width: number, height: number, x: number, y: number): number {
  const cx = x < 0 ? 0 : x >= width ? width - 1 : x;
  const cy = y < 0 ? 0 : y >= height ? height - 1 : y;
  return (cy * width + cx) * CHANNELS;
}

/**
 * Copy a rectangle out of `src`, extending the edge pixels when the rectangle
 * runs past the border. Used to give tiles the halo their filters need.
 */
export function extractRegion(
  src: Surface,
  x0: number,
  y0: number,
  width: number,
  height: number,
): Surface {
  const out = createSurface(width, height, src.colorSpace, src.premultiplied);
  const s = src.data;
  const d = out.data;
  for (let y = 0; y < height; y++) {
    const sy = Math.min(src.height - 1, Math.max(0, y0 + y));
    const rowBase = sy * src.width;
    let di = y * width * CHANNELS;
    for (let x = 0; x < width; x++) {
      const sx = Math.min(src.width - 1, Math.max(0, x0 + x));
      const si = (rowBase + sx) * CHANNELS;
      d[di] = s[si];
      d[di + 1] = s[si + 1];
      d[di + 2] = s[si + 2];
      d[di + 3] = s[si + 3];
      di += CHANNELS;
    }
  }
  return out;
}

/**
 * Write `patch` into `dst` at (x0, y0), skipping anything outside `dst`.
 * `srcX`/`srcY` let the caller drop a halo from the patch.
 */
export function blitRegion(
  dst: Surface,
  patch: Surface,
  x0: number,
  y0: number,
  srcX = 0,
  srcY = 0,
  width = patch.width - srcX,
  height = patch.height - srcY,
): void {
  const s = patch.data;
  const d = dst.data;
  for (let y = 0; y < height; y++) {
    const dy = y0 + y;
    if (dy < 0 || dy >= dst.height) continue;
    const sy = srcY + y;
    if (sy < 0 || sy >= patch.height) continue;
    let si = (sy * patch.width + srcX) * CHANNELS;
    let di = (dy * dst.width + x0) * CHANNELS;
    for (let x = 0; x < width; x++) {
      const dx = x0 + x;
      if (dx >= 0 && dx < dst.width) {
        d[di] = s[si];
        d[di + 1] = s[si + 1];
        d[di + 2] = s[si + 2];
        d[di + 3] = s[si + 3];
      }
      si += CHANNELS;
      di += CHANNELS;
    }
  }
}
