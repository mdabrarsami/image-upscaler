import { CHANNELS, type Surface } from '../image/surface.js';
import { separableMinMax } from './morphology.js';

/**
 * Anti-ringing.
 *
 * Windowed-sinc kernels have negative lobes. Near a hard edge those lobes
 * overshoot, producing the light/dark bands that show up as a "halo" on text
 * and line art. The fix used here is the standard one: for every output pixel,
 * find the min and max of the source pixels that actually contributed to it,
 * and clamp the result into that interval. A resampled pixel has no business
 * being brighter or darker than every input it was built from.
 *
 * `amount` blends between the raw (ringing) and clamped result, because a hard
 * clamp at full strength very slightly softens diagonal edges.
 *
 * The min/max is computed once over the whole *source* with a separable pass
 * and then sampled per output pixel. The source is smaller than the output by
 * the scale factor squared, so at 4x this does one sixteenth of the work that
 * scanning a window per output pixel would - which measured as a 6x speed-up
 * on this pass alone.
 */
export interface AntiRingOptions {
  /** 0..1 blend towards the clamped value. */
  amount?: number;
  /**
   * Radius of the source neighbourhood, in source pixels. Should cover the
   * kernel support; 2 is right for Lanczos-3 in practice, since the outer
   * lobes contribute little.
   */
  radius?: number;
}

/**
 * Clamp `output` (at output resolution) against `source` (at source
 * resolution). The two are related by the implied scale factor, which is read
 * off the dimensions rather than passed in, so it stays correct for
 * non-integer scales.
 */
export function antiRing(
  output: Surface,
  source: Surface,
  options: AntiRingOptions = {},
): Surface {
  const amount = options.amount ?? 0.8;
  if (amount <= 0) return output;
  const radius = Math.max(1, Math.round(options.radius ?? 2));

  const { width, height, data } = output;
  const sw = source.width;
  const sh = source.height;
  const scaleX = sw / width;
  const scaleY = sh / height;

  const { min, max } = separableMinMax(source.data, sw, sh, radius);
  const out = new Float32Array(data);

  for (let y = 0; y < height; y++) {
    // Centre of this output pixel, in source coordinates.
    let sy = Math.round((y + 0.5) * scaleY - 0.5);
    if (sy < 0) sy = 0;
    else if (sy >= sh) sy = sh - 1;
    const sourceRow = sy * sw;
    const outRow = y * width;

    for (let x = 0; x < width; x++) {
      let sx = Math.round((x + 0.5) * scaleX - 0.5);
      if (sx < 0) sx = 0;
      else if (sx >= sw) sx = sw - 1;

      const si = (sourceRow + sx) * CHANNELS;
      const di = (outRow + x) * CHANNELS;

      out[di] = blendClamp(data[di], min[si], max[si], amount);
      out[di + 1] = blendClamp(data[di + 1], min[si + 1], max[si + 1], amount);
      out[di + 2] = blendClamp(data[di + 2], min[si + 2], max[si + 2], amount);
      out[di + 3] = blendClamp(data[di + 3], min[si + 3], max[si + 3], amount);
    }
  }

  return {
    data: out,
    width,
    height,
    colorSpace: output.colorSpace,
    premultiplied: output.premultiplied,
  };
}

function blendClamp(v: number, lo: number, hi: number, amount: number): number {
  const clamped = v < lo ? lo : v > hi ? hi : v;
  return v + (clamped - v) * amount;
}

/**
 * Same idea, but the reference is at the *same* resolution as the input. Used
 * after passes that can overshoot without changing geometry (detail injection,
 * edge-directed refinement).
 */
export function antiRingLocal(
  surface: Surface,
  reference: Surface,
  amount = 0.8,
  radius = 1,
): Surface {
  if (amount <= 0) return surface;
  const { width, height, data } = surface;
  const { min, max } = separableMinMax(reference.data, width, height, radius);
  const out = new Float32Array(data);

  for (let i = 0; i < out.length; i++) {
    out[i] = blendClamp(data[i], min[i], max[i], amount);
  }

  return {
    data: out,
    width,
    height,
    colorSpace: surface.colorSpace,
    premultiplied: surface.premultiplied,
  };
}
