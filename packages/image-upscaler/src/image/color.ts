import { CHANNELS, type Surface } from './surface.js';

/**
 * sRGB transfer functions (IEC 61966-2-1).
 *
 * Resampling is a weighted average, and averaging gamma-encoded values darkens
 * gradients and shifts hue on saturated edges. So the pipeline linearises,
 * filters, and encodes back. Alpha is never transformed.
 */
export function srgbToLinearScalar(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToSrgbScalar(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

const LUT_SIZE = 4096;
const LUT_MAX = LUT_SIZE - 1;

function buildLut(fn: (c: number) => number): Float32Array {
  const lut = new Float32Array(LUT_SIZE);
  for (let i = 0; i < LUT_SIZE; i++) lut[i] = fn(i / LUT_MAX);
  return lut;
}

const SRGB_TO_LINEAR_LUT = /* @__PURE__ */ buildLut(srgbToLinearScalar);
const LINEAR_TO_SRGB_LUT = /* @__PURE__ */ buildLut(linearToSrgbScalar);

/**
 * Table lookup with linear interpolation between entries.
 *
 * At 4096 entries the worst-case deviation from the exact function is about
 * 1.4e-5, just inside one least significant bit at 16-bit depth (1.53e-5), so
 * it is lossless for any output this library can encode. Cheaper than calling
 * `Math.pow` three times per pixel, which is what the exact path costs.
 */
function lookup(lut: Float32Array, c: number): number {
  if (c <= 0) return lut[0];
  if (c >= 1) return lut[LUT_MAX];
  const pos = c * LUT_MAX;
  const i = pos | 0;
  const f = pos - i;
  const a = lut[i];
  return a + (lut[i + 1] - a) * f;
}

export function srgbToLinear(c: number): number {
  return lookup(SRGB_TO_LINEAR_LUT, c);
}

export function linearToSrgb(c: number): number {
  return lookup(LINEAR_TO_SRGB_LUT, c);
}

/** In-place sRGB -> linear. No-op if the surface is already linear. */
export function toLinear(surface: Surface): Surface {
  if (surface.colorSpace === 'linear') return surface;
  const d = surface.data;
  for (let i = 0; i < d.length; i += CHANNELS) {
    d[i] = lookup(SRGB_TO_LINEAR_LUT, d[i]);
    d[i + 1] = lookup(SRGB_TO_LINEAR_LUT, d[i + 1]);
    d[i + 2] = lookup(SRGB_TO_LINEAR_LUT, d[i + 2]);
  }
  surface.colorSpace = 'linear';
  return surface;
}

/** In-place linear -> sRGB. No-op if the surface is already sRGB. */
export function toSrgb(surface: Surface): Surface {
  if (surface.colorSpace === 'srgb') return surface;
  const d = surface.data;
  for (let i = 0; i < d.length; i += CHANNELS) {
    d[i] = lookup(LINEAR_TO_SRGB_LUT, d[i]);
    d[i + 1] = lookup(LINEAR_TO_SRGB_LUT, d[i + 1]);
    d[i + 2] = lookup(LINEAR_TO_SRGB_LUT, d[i + 2]);
  }
  surface.colorSpace = 'srgb';
  return surface;
}

/** Rec. 709 luma. Expects whatever encoding the surface currently carries. */
export function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Single-channel luma plane. Cheap enough to rebuild rather than cache. */
export function lumaPlane(surface: Surface): Float32Array {
  const { width, height, data } = surface;
  const out = new Float32Array(width * height);
  for (let p = 0, i = 0; p < out.length; p++, i += CHANNELS) {
    out[p] = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  }
  return out;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Clamp every colour channel into 0..1, leaving alpha untouched. */
export function clampSurface(surface: Surface): Surface {
  const d = surface.data;
  for (let i = 0; i < d.length; i += CHANNELS) {
    d[i] = d[i] < 0 ? 0 : d[i] > 1 ? 1 : d[i];
    d[i + 1] = d[i + 1] < 0 ? 0 : d[i + 1] > 1 ? 1 : d[i + 1];
    d[i + 2] = d[i + 2] < 0 ? 0 : d[i + 2] > 1 ? 1 : d[i + 2];
    d[i + 3] = d[i + 3] < 0 ? 0 : d[i + 3] > 1 ? 1 : d[i + 3];
  }
  return surface;
}
