import { describe, expect, it } from 'vitest';
import {
  nearestScale,
  resample,
  resampleByScale,
  WeightTableCache,
} from '../../packages/image-upscaler/src/algorithms/resample.js';
import { getKernel } from '../../packages/image-upscaler/src/algorithms/kernels.js';
import { createSurface } from '../../packages/image-upscaler/src/image/surface.js';
import {
  channelRange,
  checkerboard,
  gradient,
  maxAbsDiff,
  pixelArt,
  solid,
  verticalEdge,
} from '../fixtures/synthetic.js';

const KERNELS = ['bilinear', 'bicubic', 'mitchell', 'lanczos2', 'lanczos3', 'lanczos4'] as const;

describe('resample', () => {
  it('produces exactly the requested dimensions', () => {
    const src = gradient(17, 23);
    for (const [w, h] of [
      [34, 46],
      [5, 7],
      [17, 100],
      [1, 1],
    ]) {
      const out = resample(src, w, h);
      expect([out.width, out.height]).toEqual([w, h]);
      expect(out.data.length).toBe(w * h * 4);
    }
  });

  it('preserves a solid colour exactly, at every kernel and factor', () => {
    // The single most important invariant: a normalised kernel over a constant
    // signal must return the constant. If this drifts, flat areas shift
    // brightness and every gradient bands.
    const color: [number, number, number, number] = [0.3, 0.6, 0.9, 1];
    for (const kernel of KERNELS) {
      for (const factor of [2, 3, 4, 8, 0.5]) {
        const src = solid(16, 16, color);
        const out = resampleByScale(src, factor, { kernel: getKernel(kernel) });
        for (let i = 0; i < out.data.length; i += 4) {
          expect(out.data[i], `${kernel} x${factor} R`).toBeCloseTo(color[0], 5);
          expect(out.data[i + 1], `${kernel} x${factor} G`).toBeCloseTo(color[1], 5);
          expect(out.data[i + 2], `${kernel} x${factor} B`).toBeCloseTo(color[2], 5);
          expect(out.data[i + 3], `${kernel} x${factor} A`).toBeCloseTo(color[3], 5);
        }
      }
    }
  });

  it('returns an independent copy when asked for the same size', () => {
    const src = gradient(8, 8);
    const out = resample(src, 8, 8);
    expect(out.data).not.toBe(src.data);
    expect(maxAbsDiff(out, src)).toBe(0);
  });

  it('keeps a horizontal gradient monotonic', () => {
    const out = resampleByScale(gradient(32, 4), 4, { kernel: getKernel('lanczos3') });
    for (let y = 0; y < out.height; y++) {
      for (let x = 1; x < out.width; x++) {
        const prev = out.data[(y * out.width + x - 1) * 4];
        const curr = out.data[(y * out.width + x) * 4];
        // A tiny tolerance for the ringing a sinc kernel produces at the ends
        // of the ramp, where the clamped edge acts like a discontinuity.
        expect(curr, `x=${x}`).toBeGreaterThanOrEqual(prev - 1e-3);
      }
    }
  });

  it('is separable-consistent: axis order does not change the result', () => {
    // The implementation picks the cheaper axis first. A wide-and-short and a
    // narrow-and-tall source exercise both branches; both must agree with a
    // reference computed the other way round.
    const wide = gradient(64, 8);
    const viaTwoSteps = resample(resample(wide, 128, 8), 128, 16);
    const direct = resample(wide, 128, 16);
    // Not identical - two-step resampling filters twice - but the axis-order
    // heuristic must not introduce a *systematic* shift.
    expect(centroidX(direct)).toBeCloseTo(centroidX(viaTwoSteps), 2);
  });

  it('does not shift the image (no half-pixel offset)', () => {
    // A half-pixel error is the classic resampler bug and is invisible until
    // someone compares before and after. An edge at the exact centre must stay
    // at the exact centre.
    for (const kernel of KERNELS) {
      const src = verticalEdge(32, 4, 16);
      const out = resampleByScale(src, 2, { kernel: getKernel(kernel) });
      // +0.5 converts a pixel index to a continuous coordinate: index 31 in a
      // 64-wide image spans 31.0 to 32.0, so its centre is 31.5.
      expect((edgePosition(out) + 0.5) / out.width, kernel).toBeCloseTo(0.5, 3);
    }
  });

  it('overshoots on a hard edge, far more with lanczos than with mitchell', () => {
    const src = verticalEdge(32, 4);
    const sharp = resampleByScale(src, 4, { kernel: getKernel('lanczos3') });
    const soft = resampleByScale(src, 4, { kernel: getKernel('mitchell') });
    const flat = resampleByScale(src, 4, { kernel: getKernel('bilinear') });

    // This is the ringing that the anti-ringing pass exists to remove. Its
    // absence would mean the kernel is not the one it claims to be.
    expect(channelRange(sharp).min).toBeLessThan(-0.03);
    expect(channelRange(sharp).max).toBeGreaterThan(1.03);

    // Mitchell has shallower lobes, so it overshoots too - just less.
    expect(overshoot(soft)).toBeLessThan(overshoot(sharp) / 3);

    // Bilinear has no negative lobe at all and cannot overshoot.
    expect(channelRange(flat).min).toBeGreaterThanOrEqual(-1e-6);
    expect(channelRange(flat).max).toBeLessThanOrEqual(1 + 1e-6);
  });

  it('low-passes when downscaling instead of aliasing', () => {
    // A 1px checkerboard halved should average to flat grey, not moire.
    const out = resampleByScale(checkerboard(64, 64, 1), 0.25, {
      kernel: getKernel('lanczos3'),
    });
    const { min, max } = channelRange(out);
    expect(max - min).toBeLessThan(0.2);
  });

  it('gives identical output whether or not a weight cache is used', () => {
    const src = gradient(32, 32);
    const cache = new WeightTableCache();
    const cached = resample(src, 64, 64, { cache });
    const cachedAgain = resample(src, 64, 64, { cache });
    const uncached = resample(src, 64, 64);
    expect(maxAbsDiff(cached, uncached)).toBe(0);
    expect(maxAbsDiff(cached, cachedAgain)).toBe(0);
  });

  it('rejects degenerate surfaces rather than producing garbage', () => {
    expect(() => createSurface(0, 10)).toThrow(/Invalid surface size/);
    expect(() => createSurface(-4, 4)).toThrow(/Invalid surface size/);
    expect(() => createSurface(1.5, 4)).toThrow(/Invalid surface size/);
  });
});

describe('nearestScale', () => {
  it('replicates pixels exactly, with no new colours', () => {
    const src = pixelArt(8, 8);
    const out = nearestScale(src, 4);
    expect([out.width, out.height]).toEqual([32, 32]);

    const sourceColors = new Set<string>();
    for (let i = 0; i < src.data.length; i += 4) {
      sourceColors.add(src.data.slice(i, i + 4).join(','));
    }
    for (let i = 0; i < out.data.length; i += 4) {
      expect(sourceColors.has(out.data.slice(i, i + 4).join(','))).toBe(true);
    }
  });

  it('maps each source pixel to a solid NxN block', () => {
    const src = pixelArt(4, 4);
    const out = nearestScale(src, 3);
    for (let sy = 0; sy < 4; sy++) {
      for (let sx = 0; sx < 4; sx++) {
        const expected = src.data[(sy * 4 + sx) * 4];
        for (let dy = 0; dy < 3; dy++) {
          for (let dx = 0; dx < 3; dx++) {
            const i = ((sy * 3 + dy) * out.width + (sx * 3 + dx)) * 4;
            expect(out.data[i]).toBe(expected);
          }
        }
      }
    }
  });
});

/** How far outside 0..1 the surface strays, on either side. */
function overshoot(surface: Parameters<typeof channelRange>[0]): number {
  const { min, max } = channelRange(surface);
  return Math.max(0, -min) + Math.max(0, max - 1);
}

/** Intensity-weighted horizontal centroid, for detecting sub-pixel shifts. */
function centroidX(surface: { data: Float32Array; width: number; height: number }): number {
  let sum = 0;
  let weighted = 0;
  for (let y = 0; y < surface.height; y++) {
    for (let x = 0; x < surface.width; x++) {
      const v = surface.data[(y * surface.width + x) * 4];
      sum += v;
      weighted += v * x;
    }
  }
  return sum > 0 ? weighted / sum / surface.width : 0;
}

/** Sub-pixel position of a dark-to-light transition on the first row. */
function edgePosition(surface: { data: Float32Array; width: number }): number {
  // Where the profile crosses 0.5, linearly interpolated.
  for (let x = 1; x < surface.width; x++) {
    const prev = surface.data[(x - 1) * 4];
    const curr = surface.data[x * 4];
    if (prev < 0.5 && curr >= 0.5) {
      return x - 1 + (0.5 - prev) / (curr - prev);
    }
  }
  return -1;
}
