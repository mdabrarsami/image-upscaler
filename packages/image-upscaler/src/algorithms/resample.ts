import { CHANNELS, createSurface, type Surface } from '../image/surface.js';
import { buildWeightTable, getKernel, type FilterKernel, type KernelName, type WeightTable } from './kernels.js';

/**
 * Two-pass separable resampling.
 *
 * Horizontal first into a transient buffer, then vertical. Separable means
 * O(w*h*taps) per axis instead of O(w*h*taps^2), which for Lanczos-3 at 4x is
 * the difference between usable and not.
 */

/** Horizontal pass: (inW x h) -> (outW x h). */
function resampleAxisH(
  src: Float32Array,
  srcWidth: number,
  height: number,
  table: WeightTable,
): Float32Array {
  const outWidth = table.outputSize;
  const dst = new Float32Array(outWidth * height * CHANNELS);
  const { taps, starts, weights } = table;
  const maxX = srcWidth - 1;

  for (let y = 0; y < height; y++) {
    const rowBase = y * srcWidth * CHANNELS;
    let di = y * outWidth * CHANNELS;
    for (let x = 0; x < outWidth; x++) {
      const start = starts[x];
      const wBase = x * taps;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let t = 0; t < taps; t++) {
        const w = weights[wBase + t];
        if (w === 0) continue;
        let sx = start + t;
        if (sx < 0) sx = 0;
        else if (sx > maxX) sx = maxX;
        const si = rowBase + sx * CHANNELS;
        r += src[si] * w;
        g += src[si + 1] * w;
        b += src[si + 2] * w;
        a += src[si + 3] * w;
      }
      dst[di] = r;
      dst[di + 1] = g;
      dst[di + 2] = b;
      dst[di + 3] = a;
      di += CHANNELS;
    }
  }
  return dst;
}

/** Vertical pass: (w x inH) -> (w x outH). */
function resampleAxisV(
  src: Float32Array,
  width: number,
  srcHeight: number,
  table: WeightTable,
): Float32Array {
  const outHeight = table.outputSize;
  const dst = new Float32Array(width * outHeight * CHANNELS);
  const { taps, starts, weights } = table;
  const maxY = srcHeight - 1;
  const stride = width * CHANNELS;

  for (let y = 0; y < outHeight; y++) {
    const start = starts[y];
    const wBase = y * taps;
    let di = y * stride;
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      const col = x * CHANNELS;
      for (let t = 0; t < taps; t++) {
        const w = weights[wBase + t];
        if (w === 0) continue;
        let sy = start + t;
        if (sy < 0) sy = 0;
        else if (sy > maxY) sy = maxY;
        const si = sy * stride + col;
        r += src[si] * w;
        g += src[si + 1] * w;
        b += src[si + 2] * w;
        a += src[si + 3] * w;
      }
      dst[di] = r;
      dst[di + 1] = g;
      dst[di + 2] = b;
      dst[di + 3] = a;
      di += CHANNELS;
    }
  }
  return dst;
}

export interface ResampleOptions {
  kernel?: FilterKernel | KernelName;
  /** Reuse tables across tiles of identical geometry. */
  cache?: WeightTableCache;
}

/** Weight tables depend only on (kernel, inSize, outSize), so they cache well. */
export class WeightTableCache {
  private readonly map = new Map<string, WeightTable>();

  get(kernel: FilterKernel, inputSize: number, outputSize: number): WeightTable {
    const key = `${kernel.name}:${inputSize}:${outputSize}`;
    let table = this.map.get(key);
    if (!table) {
      table = buildWeightTable(kernel, inputSize, outputSize);
      this.map.set(key, table);
    }
    return table;
  }

  clear(): void {
    this.map.clear();
  }
}

function resolveKernel(kernel: FilterKernel | KernelName | undefined): FilterKernel {
  if (!kernel) return getKernel('lanczos3');
  return typeof kernel === 'string' ? getKernel(kernel) : kernel;
}

/**
 * Resample `src` to exactly `outWidth` x `outHeight`.
 *
 * The surface should be premultiplied and linear-light; see
 * `image/alpha.ts` and `image/color.ts` for why.
 */
export function resample(
  src: Surface,
  outWidth: number,
  outHeight: number,
  options: ResampleOptions = {},
): Surface {
  if (outWidth === src.width && outHeight === src.height) {
    return { ...src, data: new Float32Array(src.data) };
  }
  const kernel = resolveKernel(options.kernel);
  const cache = options.cache;

  const hTable = cache
    ? cache.get(kernel, src.width, outWidth)
    : buildWeightTable(kernel, src.width, outWidth);
  const vTable = cache
    ? cache.get(kernel, src.height, outHeight)
    : buildWeightTable(kernel, src.height, outHeight);

  // Run the axis that shrinks the pixel count first: it makes the second pass
  // cheaper and the intermediate buffer smaller.
  let data: Float32Array;
  const horizontalFirstCost = outWidth * src.height;
  const verticalFirstCost = src.width * outHeight;
  if (horizontalFirstCost <= verticalFirstCost) {
    data = resampleAxisH(src.data, src.width, src.height, hTable);
    data = resampleAxisV(data, outWidth, src.height, vTable);
  } else {
    data = resampleAxisV(src.data, src.width, src.height, vTable);
    data = resampleAxisH(data, src.width, outHeight, hTable);
  }
  return {
    data,
    width: outWidth,
    height: outHeight,
    colorSpace: src.colorSpace,
    premultiplied: src.premultiplied,
  };
}

/** Convenience wrapper for an integer or fractional scale factor. */
export function resampleByScale(
  src: Surface,
  scale: number,
  options: ResampleOptions = {},
): Surface {
  return resample(src, Math.round(src.width * scale), Math.round(src.height * scale), options);
}

/**
 * Nearest-neighbour magnification at an integer factor. Used by the
 * `pixel-art` mode, where any smoothing is a defect rather than a feature.
 */
export function nearestScale(src: Surface, factor: number): Surface {
  const f = Math.max(1, Math.round(factor));
  const out = createSurface(src.width * f, src.height * f, src.colorSpace, src.premultiplied);
  const s = src.data;
  const d = out.data;
  for (let y = 0; y < out.height; y++) {
    const sy = (y / f) | 0;
    const srcRow = sy * src.width * CHANNELS;
    let di = y * out.width * CHANNELS;
    for (let x = 0; x < out.width; x++) {
      const si = srcRow + ((x / f) | 0) * CHANNELS;
      d[di] = s[si];
      d[di + 1] = s[si + 1];
      d[di + 2] = s[si + 2];
      d[di + 3] = s[si + 3];
      di += CHANNELS;
    }
  }
  return out;
}
