import { describe, expect, it } from 'vitest';
import {
  blurPlane,
  blurSurface,
  gaussianKernel1D,
} from '../../packages/image-upscaler/src/algorithms/gaussian.js';
import {
  analyzeTensor,
  gradient as gradientOf,
  structureTensor,
} from '../../packages/image-upscaler/src/algorithms/edges.js';
import {
  adaptiveSharpen,
  localContrast,
  suppressHalos,
} from '../../packages/image-upscaler/src/algorithms/sharpening.js';
import {
  extractDetail,
  reconstructDetail,
  transferDetail,
} from '../../packages/image-upscaler/src/algorithms/detail.js';
import {
  bilateralDenoise,
  estimateNoise,
} from '../../packages/image-upscaler/src/algorithms/noise.js';
import {
  antiRing,
  antiRingLocal,
} from '../../packages/image-upscaler/src/algorithms/anti-ringing.js';
import { edgeDirectedRefine } from '../../packages/image-upscaler/src/algorithms/edge-directed.js';
import { resampleByScale } from '../../packages/image-upscaler/src/algorithms/resample.js';
import { lumaPlane, toLinear } from '../../packages/image-upscaler/src/image/color.js';
import {
  premultiply,
  unpremultiply,
} from '../../packages/image-upscaler/src/image/alpha.js';
import type { Surface } from '../../packages/image-upscaler/src/image/surface.js';
import {
  channelRange,
  diagonalEdge,
  gradient,
  horizontalEdge,
  mae,
  maxAbsDiff,
  noise,
  noisyGradient,
  solid,
  transparentDisc,
  verticalEdge,
} from '../fixtures/synthetic.js';

describe('gaussian blur', () => {
  it('builds a normalised, symmetric kernel', () => {
    for (const sigma of [0.5, 1, 2, 3.7]) {
      const kernel = gaussianKernel1D(sigma);
      expect(kernel.length % 2, `sigma ${sigma}`).toBe(1);
      let sum = 0;
      for (const w of kernel) sum += w;
      expect(sum, `sigma ${sigma}`).toBeCloseTo(1, 6);
      const mid = (kernel.length - 1) / 2;
      for (let i = 0; i < mid; i++) {
        expect(kernel[i]).toBeCloseTo(kernel[kernel.length - 1 - i], 12);
      }
      // Truncated at 3 sigma.
      expect(mid).toBe(Math.max(1, Math.ceil(sigma * 3)));
    }
  });

  it('preserves a constant plane exactly', () => {
    const plane = new Float32Array(64).fill(0.375);
    const out = blurPlane(plane, 8, 8, 2);
    for (const v of out) expect(v).toBeCloseTo(0.375, 6);
  });

  it('preserves a solid surface and its alpha', () => {
    const out = blurSurface(solid(16, 16, [0.2, 0.4, 0.6, 0.8]), 1.5);
    for (let i = 0; i < out.data.length; i += 4) {
      expect(out.data[i]).toBeCloseTo(0.2, 5);
      expect(out.data[i + 3]).toBeCloseTo(0.8, 5);
    }
  });

  it('reduces variance monotonically as sigma grows', () => {
    const src = noise(48, 48, 0.6);
    let previous = Infinity;
    for (const sigma of [0.5, 1, 2, 4]) {
      const v = variance(lumaPlane(blurSurface(src, sigma)));
      expect(v, `sigma ${sigma}`).toBeLessThan(previous);
      previous = v;
    }
  });

  it('does not shift the image', () => {
    const src = verticalEdge(32, 4, 16);
    const out = blurSurface(src, 2);
    // A symmetric kernel cannot move an edge; the mean of the profile is the
    // sensitive test.
    expect(rowMean(out, 0)).toBeCloseTo(rowMean(src, 0), 3);
  });
});

describe('gradient operators', () => {
  it('report zero gradient on a flat field', () => {
    const plane = new Float32Array(256).fill(0.5);
    for (const op of ['sobel', 'scharr'] as const) {
      const field = gradientOf(plane, 16, 16, op);
      for (let i = 0; i < field.gx.length; i++) {
        expect(field.gx[i], op).toBeCloseTo(0, 6);
        expect(field.gy[i], op).toBeCloseTo(0, 6);
      }
    }
  });

  it('measure a unit step as a gradient of 0.5, matching a central difference', () => {
    // The normalisation constants (1/8 for Sobel, 1/32 for Scharr) exist to
    // make this true; without them the two operators disagree by 4x and any
    // threshold tuned on one is wrong for the other.
    const plane = new Float32Array(9 * 3);
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 9; x++) plane[y * 9 + x] = x < 4 ? 0 : 1;
    }
    for (const op of ['sobel', 'scharr'] as const) {
      const field = gradientOf(plane, 9, 3, op);
      // The step sits between x=3 and x=4, so both straddling columns see 0.5.
      expect(field.gx[1 * 9 + 3], op).toBeCloseTo(0.5, 5);
      expect(field.gx[1 * 9 + 4], op).toBeCloseTo(0.5, 5);
      expect(field.gy[1 * 9 + 4], op).toBeCloseTo(0, 5);
    }
  });

  it('put the gradient across the edge, not along it', () => {
    const h = lumaPlane(horizontalEdge(16, 16));
    const field = gradientOf(h, 16, 16, 'scharr');
    const centre = 8 * 16 + 8;
    expect(Math.abs(field.gy[centre])).toBeGreaterThan(0.4);
    expect(Math.abs(field.gx[centre])).toBeLessThan(1e-5);
  });

  it('give scharr a smaller angular error than sobel', () => {
    // The reason Scharr is the default for the edge-directed pass. Scharr's
    // coefficients were derived to minimise the error in the gradient
    // *direction*, which is precisely the quantity the refinement steers on -
    // a biased direction sends the tangential average across the edge instead
    // of along it. (Magnitude consistency is a different property, and Sobel
    // is not worse at that one.)
    const angularError = (op: 'sobel' | 'scharr'): number => {
      let worst = 0;
      for (let degrees = 0; degrees < 90; degrees += 7.5) {
        const theta = (degrees * Math.PI) / 180;
        const size = 41;
        const plane = new Float32Array(size * size);
        const cos = Math.cos(theta);
        const sin = Math.sin(theta);
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            // A smooth ramp perpendicular to theta: the exact gradient
            // direction is theta everywhere, so any deviation is operator bias.
            const t = ((x - size / 2) * cos + (y - size / 2) * sin) / size;
            plane[y * size + x] = 0.5 + 0.5 * Math.tanh(t * 4);
          }
        }
        const field = gradientOf(plane, size, size, op);
        const centre = ((size >> 1) * size) + (size >> 1);
        const measured = Math.atan2(field.gy[centre], field.gx[centre]);
        const error = Math.abs(normaliseAngle(measured - theta));
        if (error > worst) worst = error;
      }
      return worst;
    };
    expect(angularError('scharr')).toBeLessThan(angularError('sobel'));
  });
});

describe('structure tensor', () => {
  it('finds a high anisotropy and the correct tangent on a clean edge', () => {
    const plane = lumaPlane(verticalEdge(32, 32));
    const tensor = structureTensor(gradientOf(plane, 32, 32, 'scharr'), 1.5, blurPlane);
    const { anisotropy, dirX, dirY } = analyzeTensor(tensor);
    const centre = 16 * 32 + 16;
    expect(anisotropy[centre]).toBeGreaterThan(0.9);
    // A vertical edge runs along y, so the tangent should be (0, +/-1).
    expect(Math.abs(dirX[centre])).toBeLessThan(0.1);
    expect(Math.abs(dirY[centre])).toBeGreaterThan(0.9);
  });

  it('finds low anisotropy in isotropic noise', () => {
    const plane = lumaPlane(noise(64, 64, 0.8));
    const tensor = structureTensor(gradientOf(plane, 64, 64, 'scharr'), 2, blurPlane);
    const { anisotropy } = analyzeTensor(tensor);
    expect(mean(anisotropy)).toBeLessThan(0.5);
  });

  it('reports the tangent of a 45-degree edge at 45 degrees', () => {
    const plane = lumaPlane(diagonalEdge(48, 48));
    const tensor = structureTensor(gradientOf(plane, 48, 48, 'scharr'), 1.5, blurPlane);
    const { dirX, dirY, anisotropy } = analyzeTensor(tensor);
    const centre = 24 * 48 + 24;
    expect(anisotropy[centre]).toBeGreaterThan(0.7);
    // Tangent components should have equal magnitude on a 45-degree edge.
    expect(Math.abs(Math.abs(dirX[centre]) - Math.abs(dirY[centre]))).toBeLessThan(0.15);
  });
});

describe('adaptive sharpening', () => {
  it('leaves a flat field alone', () => {
    const src = solid(32, 32, [0.5, 0.5, 0.5, 1]);
    const out = adaptiveSharpen(src, { amount: 1 });
    expect(maxAbsDiff(out, src)).toBeLessThan(1e-5);
  });

  it('is a no-op at zero amount, returning the same object', () => {
    const src = gradient(16, 16);
    expect(adaptiveSharpen(src, { amount: 0 })).toBe(src);
  });

  it('increases local contrast', () => {
    const src = blurSurface(verticalEdge(48, 16), 1.5);
    const out = adaptiveSharpen(src, { amount: 0.8, edgeProtection: 0 });
    expect(mean(localContrast(out))).toBeGreaterThan(mean(localContrast(src)));
  });

  it('amplifies noise less as the threshold rises', () => {
    const src = noisyGradient(64, 64, 0.05);
    const low = adaptiveSharpen(src, { amount: 0.8, threshold: 0 });
    const high = adaptiveSharpen(src, { amount: 0.8, threshold: 0.05 });
    // The soft knee is what makes a sharpening control usable on real photos:
    // without it, every grain of sensor noise gets the full gain.
    expect(highFrequencyEnergy(high)).toBeLessThan(highFrequencyEnergy(low));
  });

  it('protects hard edges in proportion to edgeProtection', () => {
    const src = verticalEdge(48, 16);
    const unprotected = adaptiveSharpen(src, {
      amount: 1,
      edgeProtection: 0,
      haloSuppression: 0,
    });
    const protectedOut = adaptiveSharpen(src, {
      amount: 1,
      edgeProtection: 1,
      haloSuppression: 0,
    });
    expect(overshootOf(protectedOut)).toBeLessThan(overshootOf(unprotected));
  });

  it('halo suppression clamps overshoot to the neighbourhood of the source', () => {
    const src = verticalEdge(48, 16);
    const loose = adaptiveSharpen(src, { amount: 1, edgeProtection: 0, haloSuppression: 0 });
    const tight = adaptiveSharpen(src, { amount: 1, edgeProtection: 0, haloSuppression: 1 });
    expect(overshootOf(tight)).toBeLessThan(overshootOf(loose));
    // At full strength the result cannot exceed the source's own range.
    expect(overshootOf(tight)).toBeLessThan(1e-6);
  });

  it('suppressHalos alone never moves a pixel outside its 3x3 source range', () => {
    const reference = gradient(32, 32);
    const wild: Surface = { ...reference, data: new Float32Array(reference.data) };
    for (let i = 0; i < wild.data.length; i += 4) wild.data[i] += 0.5;

    const out = suppressHalos(wild, reference, 1);
    for (let y = 1; y < 31; y++) {
      for (let x = 1; x < 31; x++) {
        const i = (y * 32 + x) * 4;
        const { lo, hi } = neighbourhood(reference, x, y, 0);
        expect(out.data[i], `${x},${y}`).toBeLessThanOrEqual(hi + 1e-6);
        expect(out.data[i]).toBeGreaterThanOrEqual(lo - 1e-6);
      }
    }
  });
});

describe('detail extraction and reconstruction', () => {
  it('extracts a mean-zero layer', () => {
    const layer = extractDetail(noise(64, 64, 0.5), 1);
    let sum = 0;
    let count = 0;
    for (let i = 0; i < layer.data.length; i += 4) {
      sum += layer.data[i];
      count++;
    }
    expect(Math.abs(sum / count)).toBeLessThan(1e-3);
  });

  it('includes alpha in the layer, which premultiplied data requires', () => {
    // On premultiplied data a pixel is `colour * alpha`. A filter preserves the
    // colour only if it scales all four channels by the same factor, so the
    // residual has to carry alpha too - dropping it is what tints the edge of a
    // cut-out. The alpha residual is zero for an opaque image, so this costs
    // nothing in the common case.
    const opaque = extractDetail(noise(16, 16, 0.5), 1);
    for (let i = 3; i < opaque.data.length; i += 4) expect(opaque.data[i]).toBeCloseTo(0, 6);

    const disc = extractDetail(premultiply(transparentDisc(32, 10)), 1);
    let nonZeroAlpha = 0;
    for (let i = 3; i < disc.data.length; i += 4) {
      if (Math.abs(disc.data[i]) > 1e-4) nonZeroAlpha++;
    }
    expect(nonZeroAlpha).toBeGreaterThan(0);
  });

  it('preserves the colour of partially transparent pixels through injection', () => {
    // The regression this guards: sharpening or injecting into premultiplied
    // RGB without alpha shifts the un-premultiplied hue, which reads as a
    // coloured fringe around anything with a soft edge.
    const source = premultiply(toLinear(transparentDisc(48, 14)));
    const base = resampleByScale(source, 2);
    const injected = reconstructDetail(base, extractDetail(source, 1), { amount: 1 });

    const straight = { ...injected, data: new Float32Array(injected.data) };
    unpremultiply(straight);

    let worst = 0;
    for (let i = 0; i < straight.data.length; i += 4) {
      const a = straight.data[i + 3];
      if (a > 0.2 && a < 0.8) worst = Math.max(worst, Math.abs(1 - straight.data[i]));
    }
    expect(worst).toBeLessThan(0.05);
  });

  it('extracts nothing from a flat field', () => {
    const layer = extractDetail(solid(32, 32, [0.4, 0.4, 0.4, 1]), 1);
    for (let i = 0; i < layer.data.length; i++) expect(layer.data[i]).toBeCloseTo(0, 6);
  });

  it('is a no-op at zero amount', () => {
    const base = gradient(32, 32);
    const layer = extractDetail(base, 1);
    expect(reconstructDetail(base, layer, { amount: 0 })).toBe(base);
  });

  it('leaves local brightness alone while raising local contrast', () => {
    const src = noise(48, 48, 0.4);
    const base = resampleByScale(src, 2);
    const out = transferDetail(base, src, { amount: 0.8 });

    // Mean-zero layer: the global mean must not move.
    expect(mean(lumaPlane(out))).toBeCloseTo(mean(lumaPlane(base)), 2);
    expect(mean(localContrast(out))).toBeGreaterThan(mean(localContrast(base)));
  });

  it('soft-clips large residuals instead of injecting them whole', () => {
    const base = solid(32, 32, [0.5, 0.5, 0.5, 1]);
    const layer = extractDetail(base, 1);
    // A residual far above the clamp.
    layer.data.fill(0);
    for (let i = 0; i < layer.data.length; i += 4) layer.data[i] = 1;

    const out = reconstructDetail(base, layer, { amount: 1, clamp: 0.25 });
    // 0.25 passed through plus a quarter of the excess: 0.25 + 0.75*0.25.
    const centre = (16 * 32 + 16) * 4;
    expect(out.data[centre]).toBeCloseTo(0.5 + 0.25 + 0.75 * 0.25, 2);
  });
});

describe('noise reduction', () => {
  it('is a no-op at zero amount', () => {
    const src = noise(16, 16);
    expect(bilateralDenoise(src, { amount: 0 })).toBe(src);
  });

  it('moves a noisy image closer to its clean original', () => {
    const clean = gradient(64, 64);
    const noisy = noisyGradient(64, 64, 0.1);
    const denoised = bilateralDenoise(noisy, { amount: 1 });
    expect(mae(denoised, clean)).toBeLessThan(mae(noisy, clean));
  });

  it('preserves edges better than a gaussian of comparable strength', () => {
    // The point of a bilateral filter. Compared at matched noise reduction, so
    // the comparison is not just "one blurs less".
    const src = verticalEdge(48, 48);
    const bilateral = bilateralDenoise(src, { amount: 1, spatialSigma: 2 });
    const gaussian = blurSurface(src, 2);
    expect(edgeWidth(bilateral)).toBeLessThan(edgeWidth(gaussian));
  });

  it('preserves a flat field exactly', () => {
    const src = solid(32, 32, [0.3, 0.5, 0.7, 1]);
    const out = bilateralDenoise(src, { amount: 1 });
    expect(maxAbsDiff(out, src)).toBeLessThan(1e-5);
  });

  it('estimates more noise in a noisy image than a clean one', () => {
    expect(estimateNoise(noisyGradient(64, 64, 0.12))).toBeGreaterThan(
      estimateNoise(gradient(64, 64)) * 5,
    );
  });

  it('estimates near-zero noise on a smooth gradient', () => {
    expect(estimateNoise(gradient(64, 64))).toBeLessThan(0.002);
  });

  it('scales its estimate roughly with the injected amplitude', () => {
    const low = estimateNoise(noisyGradient(96, 96, 0.04, 1));
    const high = estimateNoise(noisyGradient(96, 96, 0.16, 1));
    expect(high).toBeGreaterThan(low * 2);
  });
});

describe('anti-ringing', () => {
  it('is a no-op at zero amount', () => {
    const src = gradient(16, 16);
    const up = resampleByScale(src, 2);
    expect(antiRing(up, src, { amount: 0 })).toBe(up);
  });

  it('removes the overshoot a sinc kernel puts on a hard edge', () => {
    const src = verticalEdge(32, 8);
    const rung = resampleByScale(src, 4);
    expect(overshootOf(rung)).toBeGreaterThan(0.03);

    const clamped = antiRing(rung, src, { amount: 1, radius: 2 });
    expect(overshootOf(clamped)).toBeLessThan(1e-6);
  });

  it('blends proportionally at partial strength', () => {
    const src = verticalEdge(32, 8);
    const rung = resampleByScale(src, 4);
    const half = antiRing(rung, src, { amount: 0.5, radius: 2 });
    const full = antiRing(rung, src, { amount: 1, radius: 2 });
    expect(overshootOf(half)).toBeGreaterThan(overshootOf(full));
    expect(overshootOf(half)).toBeLessThan(overshootOf(rung));
  });

  it('leaves a smooth gradient essentially untouched', () => {
    // Anti-ringing must not cost real detail where there is no ringing.
    const src = gradient(64, 8);
    const up = resampleByScale(src, 2);
    const clamped = antiRing(up, src, { amount: 1, radius: 2 });
    expect(maxAbsDiff(clamped, up)).toBeLessThan(0.02);
  });

  it('handles non-integer scales, reading the ratio off the dimensions', () => {
    const src = verticalEdge(32, 8);
    const up = resampleByScale(src, 2.5);
    const clamped = antiRing(up, src, { amount: 1, radius: 2 });
    expect(clamped.width).toBe(up.width);
    expect(overshootOf(clamped)).toBeLessThan(1e-6);
  });

  it('antiRingLocal clamps against a same-size reference', () => {
    const reference = gradient(32, 32);
    const wild: Surface = { ...reference, data: new Float32Array(reference.data) };
    wild.data[(16 * 32 + 16) * 4] = 5;
    const out = antiRingLocal(wild, reference, 1, 1);
    const { hi } = neighbourhood(reference, 16, 16, 0);
    expect(out.data[(16 * 32 + 16) * 4]).toBeCloseTo(hi, 5);
  });
});

describe('edge-directed refinement', () => {
  it('is a no-op at zero strength, returning the same object', () => {
    const src = gradient(16, 16);
    expect(edgeDirectedRefine(src, { strength: 0 })).toBe(src);
  });

  it('leaves a flat field untouched', () => {
    const src = solid(32, 32, [0.5, 0.25, 0.75, 1]);
    const out = edgeDirectedRefine(src, { strength: 1 });
    expect(maxAbsDiff(out, src)).toBeLessThan(1e-6);
  });

  it('reduces the staircase on a diagonal edge', () => {
    const up = resampleByScale(diagonalEdge(32, 32), 4);
    const refined = edgeDirectedRefine(up, { strength: 1 });
    // Staircase energy: how much the edge position wobbles row to row.
    expect(staircaseEnergy(refined)).toBeLessThan(staircaseEnergy(up));
  });

  it('leaves noise alone, because anisotropy there is low', () => {
    const src = noise(64, 64, 0.6);
    const out = edgeDirectedRefine(src, { strength: 1 });
    // Some pixels will pass the threshold by chance; the bulk must not.
    expect(mae(out, src)).toBeLessThan(0.02);
  });

  it('does not introduce out-of-range values on an axis-aligned edge', () => {
    const up = resampleByScale(verticalEdge(32, 32), 2);
    const before = channelRange(up);
    const after = channelRange(edgeDirectedRefine(up, { strength: 1 }));
    expect(after.min).toBeGreaterThanOrEqual(before.min - 1e-6);
    expect(after.max).toBeLessThanOrEqual(before.max + 1e-6);
  });
});

// --- helpers --------------------------------------------------------------

function mean(values: Float32Array): number {
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function variance(values: Float32Array): number {
  const m = mean(values);
  let sum = 0;
  for (const v of values) sum += (v - m) * (v - m);
  return sum / values.length;
}

/** Wrap an angle difference into -pi..pi. */
function normaliseAngle(radians: number): number {
  let a = radians;
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}


function rowMean(surface: Surface, y: number): number {
  let sum = 0;
  for (let x = 0; x < surface.width; x++) sum += surface.data[(y * surface.width + x) * 4];
  return sum / surface.width;
}

function overshootOf(surface: Surface): number {
  const { min, max } = channelRange(surface);
  return Math.max(0, -min) + Math.max(0, max - 1);
}

function neighbourhood(
  surface: Surface,
  x: number,
  y: number,
  channel: number,
): { lo: number; hi: number } {
  let lo = Infinity;
  let hi = -Infinity;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const yy = Math.min(surface.height - 1, Math.max(0, y + dy));
      const xx = Math.min(surface.width - 1, Math.max(0, x + dx));
      const v = surface.data[(yy * surface.width + xx) * 4 + channel];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  return { lo, hi };
}

/** Sum of squared Laplacian - a proxy for high-frequency energy. */
function highFrequencyEnergy(surface: Surface): number {
  const luma = lumaPlane(surface);
  const { width, height } = surface;
  let sum = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const p = y * width + x;
      const lap = 4 * luma[p] - luma[p - 1] - luma[p + 1] - luma[p - width] - luma[p + width];
      sum += lap * lap;
    }
  }
  return sum;
}

/** Number of columns in the transition band of a vertical edge. */
function edgeWidth(surface: Surface): number {
  const luma = lumaPlane(surface);
  const y = surface.height >> 1;
  let count = 0;
  for (let x = 0; x < surface.width; x++) {
    const v = luma[y * surface.width + x];
    if (v > 0.1 && v < 0.9) count++;
  }
  return count;
}

/**
 * Row-to-row variation in the sub-pixel position of a diagonal edge. A clean
 * diagonal advances by a constant amount each row; a staircase does not.
 */
function staircaseEnergy(surface: Surface): number {
  const luma = lumaPlane(surface);
  const positions: number[] = [];
  for (let y = 0; y < surface.height; y++) {
    for (let x = 1; x < surface.width; x++) {
      const prev = luma[y * surface.width + x - 1];
      const curr = luma[y * surface.width + x];
      if (prev < 0.5 && curr >= 0.5) {
        positions.push(x - 1 + (0.5 - prev) / (curr - prev));
        break;
      }
    }
  }
  if (positions.length < 3) return 0;
  // Second difference: zero for a perfectly straight line at any angle.
  let sum = 0;
  for (let i = 2; i < positions.length; i++) {
    const d = positions[i] - 2 * positions[i - 1] + positions[i - 2];
    sum += d * d;
  }
  return sum / (positions.length - 2);
}
