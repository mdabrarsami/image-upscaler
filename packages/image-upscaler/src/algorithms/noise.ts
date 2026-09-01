import { CHANNELS, type Surface } from '../image/surface.js';
import { lumaPlane } from '../image/color.js';

export interface DenoiseOptions {
  /** 0..1. Scales the spatial radius, the range sigma, and the final blend. */
  amount?: number;
  /** Spatial sigma in pixels. Derived from `amount` when omitted. */
  spatialSigma?: number;
  /** Range (intensity) sigma. Derived from `amount` when omitted. */
  rangeSigma?: number;
}

/**
 * Edge-preserving bilateral denoise.
 *
 * Weights combine a spatial Gaussian with a range Gaussian on luma difference,
 * so pixels that are near in space and similar in brightness average together
 * while edges stay put. Driving the range term from luma rather than
 * per-channel distance keeps chroma from separating on coloured edges.
 *
 * Run this before upscaling, never after: enlarging noise first and smoothing
 * it second costs more time and destroys more real detail.
 */
export function bilateralDenoise(src: Surface, options: DenoiseOptions = {}): Surface {
  const amount = options.amount ?? 0.3;
  if (amount <= 0) return src;

  const spatialSigma = options.spatialSigma ?? 0.8 + amount * 1.4;
  const rangeSigma = options.rangeSigma ?? 0.012 + amount * 0.05;
  const radius = Math.max(1, Math.min(4, Math.ceil(spatialSigma * 2)));

  const { width, height, data } = src;
  const luma = lumaPlane(src);
  const out = new Float32Array(data);

  // The spatial term depends only on the offset, so it is precomputed once.
  const size = radius * 2 + 1;
  const spatial = new Float32Array(size * size);
  const inv2ss = 1 / (2 * spatialSigma * spatialSigma);
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      spatial[(dy + radius) * size + (dx + radius)] = Math.exp(-(dx * dx + dy * dy) * inv2ss);
    }
  }
  // Range weights come from a lookup table rather than `Math.exp` per tap.
  // With a radius-4 window that is 81 exponentials per pixel, which profiling
  // showed to be the single most expensive thing in the denoiser. The table is
  // indexed by squared luma difference and covers out to 4 sigma, beyond which
  // the weight is small enough to treat as zero.
  const inv2rs = 1 / (2 * rangeSigma * rangeSigma);
  const RANGE_LUT_SIZE = 1024;
  const maxDl = rangeSigma * 4;
  const maxDl2 = maxDl * maxDl;
  const lutScale = (RANGE_LUT_SIZE - 1) / maxDl2;
  const rangeLut = new Float32Array(RANGE_LUT_SIZE);
  for (let i = 0; i < RANGE_LUT_SIZE; i++) {
    rangeLut[i] = Math.exp(-(i / lutScale) * inv2rs);
  }

  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const centerLuma = luma[p];
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);

      let wsum = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let yy = y0; yy <= y1; yy++) {
        const spatialRow = (yy - y + radius) * size + radius - x;
        const row = yy * width;
        for (let xx = x0; xx <= x1; xx++) {
          const dl = luma[row + xx] - centerLuma;
          const dl2 = dl * dl;
          if (dl2 >= maxDl2) continue;
          const w = spatial[spatialRow + xx] * rangeLut[(dl2 * lutScale) | 0];
          const j = (row + xx) * CHANNELS;
          r += data[j] * w;
          g += data[j + 1] * w;
          b += data[j + 2] * w;
          wsum += w;
        }
      }
      if (wsum <= 0) continue;
      const inv = 1 / wsum;
      const i = p * CHANNELS;
      // Blend by `amount` so the control is continuous rather than on/off.
      out[i] += (r * inv - data[i]) * amount;
      out[i + 1] += (g * inv - data[i + 1]) * amount;
      out[i + 2] += (b * inv - data[i + 2]) * amount;
    }
  }

  return {
    data: out,
    width,
    height,
    colorSpace: src.colorSpace,
    premultiplied: src.premultiplied,
  };
}

/**
 * Rough noise estimate: the median absolute Laplacian response, converted to a
 * standard deviation. Used to decide how hard to denoise when the caller has
 * not specified an amount.
 */
export function estimateNoise(src: Surface): number {
  const { width, height } = src;
  if (width < 3 || height < 3) return 0;
  const luma = lumaPlane(src);
  const samples: number[] = [];
  // Sparse grid: a full pass buys no useful accuracy here.
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 20000)));
  for (let y = 1; y < height - 1; y += step) {
    for (let x = 1; x < width - 1; x += step) {
      const p = y * width + x;
      const lap = 4 * luma[p] - luma[p - 1] - luma[p + 1] - luma[p - width] - luma[p + width];
      samples.push(Math.abs(lap));
    }
  }
  if (samples.length === 0) return 0;
  samples.sort((a, b) => a - b);
  const median = samples[samples.length >> 1];
  // median(|x|) -> sigma for a Gaussian is a division by 0.6745; the
  // 4-neighbour Laplacian has gain sqrt(20) on white noise.
  return median / 0.6745 / Math.sqrt(20);
}
