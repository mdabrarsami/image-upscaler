import { describe, expect, it } from 'vitest';
import {
  clampSurface,
  linearToSrgb,
  linearToSrgbScalar,
  lumaPlane,
  srgbToLinear,
  srgbToLinearScalar,
  toLinear,
  toSrgb,
} from '../../packages/image-upscaler/src/image/color.js';
import {
  bleedEdges,
  hasTransparency,
  premultiply,
  unpremultiply,
} from '../../packages/image-upscaler/src/image/alpha.js';
import { resample } from '../../packages/image-upscaler/src/algorithms/resample.js';
import { createSurface, type Surface } from '../../packages/image-upscaler/src/image/surface.js';
import { gradient, solid, transparentDisc } from '../fixtures/synthetic.js';

describe('sRGB transfer functions', () => {
  it('round-trip to within a 16-bit least significant bit', () => {
    for (let i = 0; i <= 1000; i++) {
      const v = i / 1000;
      expect(linearToSrgbScalar(srgbToLinearScalar(v))).toBeCloseTo(v, 6);
    }
  });

  it('pin the endpoints exactly', () => {
    expect(srgbToLinearScalar(0)).toBe(0);
    expect(srgbToLinearScalar(1)).toBeCloseTo(1, 12);
    expect(linearToSrgbScalar(0)).toBe(0);
    expect(linearToSrgbScalar(1)).toBeCloseTo(1, 12);
  });

  it('put mid-grey where the standard says it goes', () => {
    // sRGB 0.5 is linear 0.2140, the number that makes "50% grey is not half
    // as bright" true. Getting this wrong is what makes naive resizers darken.
    expect(srgbToLinearScalar(0.5)).toBeCloseTo(0.21404, 4);
    expect(linearToSrgbScalar(0.5)).toBeCloseTo(0.73536, 4);
  });

  it('are continuous across the linear-segment breakpoint', () => {
    // The curve switches from a linear segment to a power function at 0.04045.
    // A discontinuity there would show as a visible step in dark gradients.
    const below = srgbToLinearScalar(0.04044);
    const above = srgbToLinearScalar(0.04046);
    expect(Math.abs(above - below)).toBeLessThan(1e-5);
  });

  it('the interpolated lookup tables track the exact functions closely', () => {
    // The tables exist purely for speed; if they drift, colours shift.
    let worstForward = 0;
    let worstBackward = 0;
    for (let i = 0; i <= 4000; i++) {
      const v = i / 4000;
      worstForward = Math.max(worstForward, Math.abs(srgbToLinear(v) - srgbToLinearScalar(v)));
      worstBackward = Math.max(worstBackward, Math.abs(linearToSrgb(v) - linearToSrgbScalar(v)));
    }
    // Under one least significant bit at 16-bit depth (1/65535 = 1.53e-5), so
    // the table is lossless for any output depth this library can produce.
    // Measured worst case is about 1.4e-5, on the steepest part of the curve.
    const lsb16 = 1 / 65535;
    expect(worstForward).toBeLessThan(lsb16);
    expect(worstBackward).toBeLessThan(lsb16);
  });
});

describe('surface colour conversion', () => {
  it('round-trips a whole surface and leaves alpha untouched', () => {
    const src = gradient(32, 8);
    src.data[3] = 0.42;
    const original = new Float32Array(src.data);

    toLinear(src);
    expect(src.colorSpace).toBe('linear');
    toSrgb(src);
    expect(src.colorSpace).toBe('srgb');

    for (let i = 0; i < original.length; i++) {
      expect(src.data[i]).toBeCloseTo(original[i], 5);
    }
    expect(src.data[3]).toBeCloseTo(0.42, 6);
  });

  it('is a no-op when already in the target space', () => {
    const src = gradient(8, 8);
    toLinear(src);
    const afterFirst = new Float32Array(src.data);
    toLinear(src);
    expect(Array.from(src.data)).toEqual(Array.from(afterFirst));
  });

  it('makes averaging two colours brighter than averaging them gamma-encoded', () => {
    // The concrete reason the pipeline linearises: mixing black and white in
    // sRGB gives 0.5, which displays far darker than the true 50% mix.
    const black = 0;
    const white = 1;
    const naive = (black + white) / 2;
    const correct = linearToSrgbScalar((srgbToLinearScalar(black) + srgbToLinearScalar(white)) / 2);
    expect(correct).toBeGreaterThan(naive);
    expect(correct).toBeCloseTo(0.7354, 3);
  });

  it('clamps out-of-range values on every channel', () => {
    const s = createSurface(2, 1);
    s.data.set([-0.5, 1.5, 0.5, 2, 0.2, -1, 0.9, -0.1]);
    clampSurface(s);
    // Compared approximately because Float32 cannot hold 0.2 or 0.9 exactly.
    const expected = [0, 1, 0.5, 1, 0.2, 0, 0.9, 0];
    for (let i = 0; i < expected.length; i++) {
      expect(s.data[i], `channel ${i}`).toBeCloseTo(expected[i], 6);
    }
  });

  it('computes Rec. 709 luma', () => {
    const s = solid(2, 2, [1, 0, 0, 1]);
    expect(lumaPlane(s)[0]).toBeCloseTo(0.2126, 6);
    const g = solid(2, 2, [0, 1, 0, 1]);
    expect(lumaPlane(g)[0]).toBeCloseTo(0.7152, 6);
    const b = solid(2, 2, [0, 0, 1, 1]);
    expect(lumaPlane(b)[0]).toBeCloseTo(0.0722, 6);
  });
});

describe('alpha', () => {
  it('premultiply and unpremultiply round-trip on visible pixels', () => {
    const src = createSurface(4, 1);
    src.data.set([
      0.8, 0.4, 0.2, 1, //
      0.8, 0.4, 0.2, 0.5,
      0.8, 0.4, 0.2, 0.01,
      0.8, 0.4, 0.2, 0,
    ]);
    const original = new Float32Array(src.data);

    premultiply(src);
    expect(src.premultiplied).toBe(true);
    expect(src.data[4]).toBeCloseTo(0.4, 6); // 0.8 * 0.5

    unpremultiply(src);
    expect(src.premultiplied).toBe(false);
    for (let i = 0; i < 12; i++) {
      expect(src.data[i], `channel ${i}`).toBeCloseTo(original[i], 5);
    }
  });

  it('zeroes colour under fully transparent pixels rather than dividing by zero', () => {
    const src = createSurface(1, 1);
    src.data.set([0.8, 0.4, 0.2, 0]);
    premultiply(src);
    unpremultiply(src);
    expect(Array.from(src.data.slice(0, 3))).toEqual([0, 0, 0]);
    expect(src.data[3]).toBe(0);
  });

  it('is idempotent in both directions', () => {
    const src = solid(4, 4, [0.5, 0.5, 0.5, 0.5]);
    premultiply(src);
    const once = new Float32Array(src.data);
    premultiply(src);
    expect(Array.from(src.data)).toEqual(Array.from(once));
  });

  it('detects transparency', () => {
    expect(hasTransparency(solid(4, 4, [1, 1, 1, 1]))).toBe(false);
    expect(hasTransparency(solid(4, 4, [1, 1, 1, 0.5]))).toBe(true);
    expect(hasTransparency(transparentDisc(16))).toBe(true);
  });

  it('resampling premultiplied alpha produces no dark fringe; straight alpha does', () => {
    // This is the headline transparency bug the premultiply step prevents.
    // A red disc on transparent *black*: filtering straight RGBA pulls that
    // black into the edge, so the ring around the disc goes dark red.
    const src = transparentDisc(32, 10);

    const straight = resample(src, 64, 64);
    const premul = resample(premultiply(cloneOf(src)), 64, 64);
    unpremultiply(premul);

    expect(edgeHueError(straight)).toBeGreaterThan(edgeHueError(premul) * 3);
    // The premultiplied path keeps partially transparent pixels red.
    expect(edgeHueError(premul)).toBeLessThan(0.05);
  });

  it('bleedEdges pushes colour outwards without touching alpha', () => {
    const src = transparentDisc(24, 6);
    const alphaBefore = Array.from(src.data.filter((_, i) => i % 4 === 3));

    bleedEdges(src, 4);

    const alphaAfter = Array.from(src.data.filter((_, i) => i % 4 === 3));
    expect(alphaAfter).toEqual(alphaBefore);

    // A transparent pixel just outside the disc should now carry red rather
    // than the black it started with.
    let bled = 0;
    for (let i = 0; i < src.data.length; i += 4) {
      if (src.data[i + 3] === 0 && src.data[i] > 0.1) bled++;
    }
    expect(bled).toBeGreaterThan(0);
  });

  it('bleedEdges reaches beyond the first ring', () => {
    // The flood has to track which pixels it has already filled, or it stops
    // after one iteration - filled pixels keep alpha 0 and would not qualify
    // as donors on the next pass.
    const src = createSurface(9, 1);
    src.data.fill(0);
    src.data.set([1, 1, 1, 1], 0); // one opaque white pixel at x=0

    bleedEdges(src, 5);

    for (let x = 1; x <= 5; x++) {
      expect(src.data[x * 4], `x=${x}`).toBeGreaterThan(0.5);
    }
  });

  it('bleedEdges refuses premultiplied input', () => {
    const src = premultiply(transparentDisc(8, 3));
    expect(() => bleedEdges(src)).toThrow(/straight alpha/);
  });

  it('bleedEdges leaves a fully opaque surface alone', () => {
    const src = solid(8, 8, [0.3, 0.6, 0.9, 1]);
    const before = new Float32Array(src.data);
    bleedEdges(src, 4);
    expect(Array.from(src.data)).toEqual(Array.from(before));
  });
});

function cloneOf(surface: Surface): Surface {
  return { ...surface, data: new Float32Array(surface.data) };
}

/**
 * Average deviation from pure red hue among partially transparent pixels. A
 * dark fringe shows up as red dropping while green and blue stay at zero, so
 * the metric is how far the red channel has fallen below 1.
 */
function edgeHueError(surface: Surface): number {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < surface.data.length; i += 4) {
    const a = surface.data[i + 3];
    if (a > 0.15 && a < 0.85) {
      sum += Math.abs(1 - surface.data[i]);
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}
