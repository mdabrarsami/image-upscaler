import { CHANNELS, type Surface } from '../image/surface.js';
import { lumaPlane } from '../image/color.js';
import { blurPlane, blurSurface } from './gaussian.js';
import { gradient, gradientMagnitude } from './edges.js';
import { separableMinMax } from './morphology.js';

export interface SharpenOptions {
  /** 0..1 mapped onto a sensible unsharp amount. */
  amount?: number;
  /** Gaussian sigma of the unsharp mask, in output pixels. */
  radius?: number;
  /**
   * 0..1. Higher values pull sharpening away from strong edges (where it
   * causes halos) and towards mid-contrast detail (where it reads as acuity).
   */
  edgeProtection?: number;
  /** Contrast below this is treated as noise and not amplified. */
  threshold?: number;
  /** 0..1 clamp on how far a pixel may overshoot its neighbourhood. */
  haloSuppression?: number;
  /**
   * Gradient magnitude that counts as a fully protected edge.
   *
   * A fixed reference rather than a percentile of this image's own gradients.
   * A percentile would be a *global* statistic, and a tile would then compute a
   * different one from the whole frame - which is precisely how tiled output
   * grows visible seams. 0.25 per pixel is a firm edge in linear light; the
   * value is deliberately not adaptive.
   */
  edgeReference?: number;
}

/**
 * Adaptive unsharp masking.
 *
 * Plain unsharp masking amplifies everything, including sensor noise in flat
 * areas and the already-steep sides of hard edges, which is where halos come
 * from. Two masks fix that:
 *
 *   - a threshold with a soft knee, so low-amplitude differences (noise) are
 *     attenuated rather than boosted;
 *   - an edge-protection term driven by gradient magnitude, which rolls the
 *     gain off on the strongest edges.
 *
 * A local min/max clamp then caps any remaining overshoot.
 */
export function adaptiveSharpen(src: Surface, options: SharpenOptions = {}): Surface {
  const amount01 = options.amount ?? 0.4;
  if (amount01 <= 0) return src;

  // 0..1 maps to 0..1.6x unsharp gain; beyond that it stops looking like
  // detail and starts looking like an artefact.
  const amount = amount01 * 1.6;
  const radius = options.radius ?? 0.9;
  const edgeProtection = options.edgeProtection ?? 0.5;
  const threshold = options.threshold ?? 0.008;
  const haloSuppression = options.haloSuppression ?? 0.6;
  const edgeReference = options.edgeReference ?? 0.25;

  const { width, height, data } = src;
  const blurred = blurSurface(src, radius).data;

  // Edge map from the blurred luma: using the sharp one would let noise drive
  // the protection mask.
  const luma = lumaPlane({ ...src, data: blurred });
  const mag = gradientMagnitude(gradient(luma, width, height, 'sobel'));

  const invEdgeReference = 1 / edgeReference;

  const out = new Float32Array(data);
  const kneeInv = 1 / Math.max(1e-6, threshold * 2);

  for (let p = 0, i = 0; p < width * height; p++, i += CHANNELS) {
    const g = Math.min(1, mag[p] * invEdgeReference);
    // 1 in flat/mid areas, falling towards (1 - edgeProtection) on hard edges.
    const gain = amount * (1 - edgeProtection * g * g);
    if (gain <= 0) continue;

    const dr = data[i] - blurred[i];
    const dg = data[i + 1] - blurred[i + 1];
    const db = data[i + 2] - blurred[i + 2];
    const da = data[i + 3] - blurred[i + 3];

    // One knee per pixel, from the luma of the residual, applied to all four
    // channels. Two reasons, and the second is a correctness requirement:
    //
    //  - a per-channel threshold lets one channel pass while another is
    //    suppressed, which shifts hue on low-contrast coloured detail;
    //  - on premultiplied data a pixel is `colour * alpha`, so only a filter
    //    that scales every channel by the same factor leaves the colour alone.
    //    Sharpening RGB and not alpha is exactly what produces a coloured
    //    fringe around a cut-out after un-premultiplying.
    const residual = Math.abs(0.2126 * dr + 0.7152 * dg + 0.0722 * db);
    // Soft knee: fully suppressed below `threshold`, fully passed above 2x.
    const knee = residual <= threshold ? 0 : Math.min(1, (residual - threshold) * kneeInv);
    if (knee <= 0) continue;

    const scale = gain * knee;
    out[i] = data[i] + dr * scale;
    out[i + 1] = data[i + 1] + dg * scale;
    out[i + 2] = data[i + 2] + db * scale;
    out[i + 3] = data[i + 3] + da * scale;
  }

  const sharpened: Surface = {
    data: out,
    width,
    height,
    colorSpace: src.colorSpace,
    premultiplied: src.premultiplied,
  };

  return haloSuppression > 0 ? suppressHalos(sharpened, src, haloSuppression) : sharpened;
}

/**
 * Clamp each pixel to the 3x3 min/max of the *unsharpened* image, then blend
 * back by `amount`. This is what actually kills halos: a sharpened pixel is
 * allowed to be at the extreme of its neighbourhood but not beyond it.
 *
 * Alpha is clamped too. On premultiplied data every channel is the same alpha
 * scaled by a constant, so the per-channel ranges are proportional and the
 * clamp comes out to the same factor on each channel - which is what keeps the
 * colour of partially transparent pixels intact.
 */
export function suppressHalos(sharpened: Surface, reference: Surface, amount = 0.6): Surface {
  if (amount <= 0) return sharpened;
  const { width, height } = sharpened;
  const out = new Float32Array(sharpened.data);
  const { min, max } = separableMinMax(reference.data, width, height, 1);
  const data = sharpened.data;

  for (let i = 0; i < out.length; i++) {
    const v = data[i];
    const lo = min[i];
    const hi = max[i];
    const clamped = v < lo ? lo : v > hi ? hi : v;
    out[i] = v + (clamped - v) * amount;
  }

  return {
    data: out,
    width,
    height,
    colorSpace: sharpened.colorSpace,
    premultiplied: sharpened.premultiplied,
  };
}

/** Local contrast plane, useful as a mask elsewhere. */
export function localContrast(src: Surface, sigma = 2): Float32Array {
  const luma = lumaPlane(src);
  const blurred = blurPlane(luma, src.width, src.height, sigma);
  const out = new Float32Array(luma.length);
  for (let i = 0; i < luma.length; i++) out[i] = Math.abs(luma[i] - blurred[i]);
  return out;
}
