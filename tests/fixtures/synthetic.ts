import { createSurface, type Surface } from '../../packages/image-upscaler/src/image/surface.js';

/**
 * Synthetic test images.
 *
 * Every one of these has a property that can be asserted exactly, which is
 * what makes them worth more than a photograph for testing: a solid colour
 * must survive resampling bit-for-bit, a gradient must stay monotonic, a
 * checkerboard must not shift phase, an edge must not gain overshoot beyond a
 * known bound.
 */

export type Rgba = [number, number, number, number];

function fill(surface: Surface, fn: (x: number, y: number) => Rgba): Surface {
  const { width, height, data } = surface;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = fn(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return surface;
}

export function solid(width: number, height: number, color: Rgba = [0.5, 0.25, 0.75, 1]): Surface {
  return fill(createSurface(width, height), () => color);
}

/** Horizontal 0 -> 1 ramp in all three channels. */
export function gradient(width: number, height: number): Surface {
  return fill(createSurface(width, height), (x) => {
    const v = width > 1 ? x / (width - 1) : 0;
    return [v, v, v, 1];
  });
}

/** Hard vertical edge: black left of `at`, white from `at` onwards. */
export function verticalEdge(width: number, height: number, at = width >> 1): Surface {
  return fill(createSurface(width, height), (x) => (x < at ? [0, 0, 0, 1] : [1, 1, 1, 1]));
}

export function horizontalEdge(width: number, height: number, at = height >> 1): Surface {
  return fill(createSurface(width, height), (_x, y) => (y < at ? [0, 0, 0, 1] : [1, 1, 1, 1]));
}

/** 45-degree edge; the case separable kernels handle worst. */
export function diagonalEdge(width: number, height: number): Surface {
  return fill(createSurface(width, height), (x, y) => (x > y ? [1, 1, 1, 1] : [0, 0, 0, 1]));
}

export function checkerboard(width: number, height: number, cell = 1): Surface {
  return fill(createSurface(width, height), (x, y) => {
    const on = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0;
    return on ? [1, 1, 1, 1] : [0, 0, 0, 1];
  });
}

/**
 * Deterministic pseudo-random noise. A fixed LCG rather than `Math.random` so
 * a failing assertion is reproducible.
 */
export function noise(width: number, height: number, amplitude = 0.5, seed = 12345): Surface {
  let state = seed >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  return fill(createSurface(width, height), () => {
    const base = 0.5;
    return [
      base + (next() - 0.5) * amplitude,
      base + (next() - 0.5) * amplitude,
      base + (next() - 0.5) * amplitude,
      1,
    ];
  });
}

/** Grey with additive noise on top - a signal a denoiser should recover. */
export function noisyGradient(width: number, height: number, amplitude = 0.08, seed = 7): Surface {
  let state = seed >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  return fill(createSurface(width, height), (x) => {
    const v = width > 1 ? x / (width - 1) : 0;
    const n = (next() - 0.5) * amplitude;
    return [clamp(v + n), clamp(v + n), clamp(v + n), 1];
  });
}

/**
 * An opaque red disc on a fully transparent background whose RGB is black.
 * Any alpha mishandling shows up as a dark ring around the disc.
 */
export function transparentDisc(size: number, radius = size * 0.3): Surface {
  const c = (size - 1) / 2;
  return fill(createSurface(size, size), (x, y) => {
    const inside = Math.hypot(x - c, y - c) <= radius;
    return inside ? [1, 0, 0, 1] : [0, 0, 0, 0];
  });
}

/** Blocky glyph-like shapes: high-contrast, thin strokes, sharp corners. */
export function textLike(width: number, height: number): Surface {
  return fill(createSurface(width, height), (x, y) => {
    const stroke =
      (y % 8 === 2 && x % 16 < 10) || // horizontal bars
      (x % 16 === 3 && y % 8 >= 2 && y % 8 <= 6); // vertical stems
    return stroke ? [0, 0, 0, 1] : [1, 1, 1, 1];
  });
}

/** One-pixel-wide lines, the classic aliasing stress case. */
export function fineLines(width: number, height: number, period = 4): Surface {
  return fill(createSurface(width, height), (x) =>
    x % period === 0 ? [0, 0, 0, 1] : [1, 1, 1, 1],
  );
}

export function pixelArt(width: number, height: number): Surface {
  const palette: Rgba[] = [
    [0.1, 0.1, 0.15, 1],
    [0.9, 0.2, 0.2, 1],
    [0.2, 0.7, 0.3, 1],
    [0.95, 0.85, 0.2, 1],
  ];
  return fill(createSurface(width, height), (x, y) => palette[(x * 3 + y * 5) % palette.length]);
}

function clamp(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// --- measurement ----------------------------------------------------------

export function mse(a: Surface, b: Surface, channels = 3): number {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`Size mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
  let sum = 0;
  let count = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    for (let c = 0; c < channels; c++) {
      const d = a.data[i + c] - b.data[i + c];
      sum += d * d;
      count++;
    }
  }
  return sum / count;
}

export function mae(a: Surface, b: Surface, channels = 3): number {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    for (let c = 0; c < channels; c++) {
      sum += Math.abs(a.data[i + c] - b.data[i + c]);
      count++;
    }
  }
  return sum / count;
}

/** PSNR in dB against a peak signal of 1.0. Infinite for identical inputs. */
export function psnr(a: Surface, b: Surface): number {
  const error = mse(a, b);
  if (error === 0) return Infinity;
  return 10 * Math.log10(1 / error);
}

/**
 * Global SSIM on the luma plane, 8x8 windows, the standard C1/C2 constants.
 *
 * Windowed rather than global statistics, because global SSIM is nearly
 * useless - it cannot tell a locally blurred image from a sharp one with the
 * same overall variance.
 */
export function ssim(a: Surface, b: Surface, windowSize = 8): number {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error('SSIM needs matching dimensions');
  }
  const la = luma(a);
  const lb = luma(b);
  const C1 = 0.01 * 0.01;
  const C2 = 0.03 * 0.03;

  let total = 0;
  let windows = 0;
  for (let y = 0; y + windowSize <= a.height; y += windowSize) {
    for (let x = 0; x + windowSize <= a.width; x += windowSize) {
      let sumA = 0;
      let sumB = 0;
      let sumAA = 0;
      let sumBB = 0;
      let sumAB = 0;
      const n = windowSize * windowSize;
      for (let dy = 0; dy < windowSize; dy++) {
        for (let dx = 0; dx < windowSize; dx++) {
          const i = (y + dy) * a.width + (x + dx);
          const va = la[i];
          const vb = lb[i];
          sumA += va;
          sumB += vb;
          sumAA += va * va;
          sumBB += vb * vb;
          sumAB += va * vb;
        }
      }
      const muA = sumA / n;
      const muB = sumB / n;
      const varA = sumAA / n - muA * muA;
      const varB = sumBB / n - muB * muB;
      const covAB = sumAB / n - muA * muB;
      total +=
        ((2 * muA * muB + C1) * (2 * covAB + C2)) /
        ((muA * muA + muB * muB + C1) * (varA + varB + C2));
      windows++;
    }
  }
  return windows > 0 ? total / windows : 1;
}

function luma(surface: Surface): Float32Array {
  const out = new Float32Array(surface.width * surface.height);
  for (let p = 0, i = 0; p < out.length; p++, i += 4) {
    out[p] = 0.2126 * surface.data[i] + 0.7152 * surface.data[i + 1] + 0.0722 * surface.data[i + 2];
  }
  return out;
}

/** Largest absolute difference on any channel. */
export function maxAbsDiff(a: Surface, b: Surface): number {
  let worst = 0;
  for (let i = 0; i < a.data.length; i++) {
    const d = Math.abs(a.data[i] - b.data[i]);
    if (d > worst) worst = d;
  }
  return worst;
}

/** Min and max of one channel across the whole surface. */
export function channelRange(surface: Surface, channel = 0): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (let i = channel; i < surface.data.length; i += 4) {
    if (surface.data[i] < min) min = surface.data[i];
    if (surface.data[i] > max) max = surface.data[i];
  }
  return { min, max };
}
