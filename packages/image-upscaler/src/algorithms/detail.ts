import { CHANNELS, type Surface } from '../image/surface.js';
import { blurSurface } from './gaussian.js';
import { resample } from './resample.js';
import { getKernel } from './kernels.js';

/**
 * Detail extraction and reconstruction.
 *
 * Any interpolation is a low-pass filter: the output is band-limited to the
 * Nyquist frequency of the source no matter how good the kernel is. What it
 * can do is put the high-frequency band of the source back where it belongs at
 * the new resolution, at the right amplitude. That is what this does - no
 * invention, just redistribution.
 *
 * The detail layer is extracted at source resolution (src - blur(src)), carried
 * up with a smooth kernel, and re-injected. Because the layer is mean-zero,
 * adding it changes local contrast without shifting local brightness.
 *
 * Alpha is filtered along with colour, and the soft-clip factor is shared
 * across all four channels. That is not an aesthetic choice: on premultiplied
 * data a pixel is `colour * alpha`, so a filter only leaves the colour intact
 * if it treats every channel identically. Sharpening RGB while leaving alpha
 * alone breaks that relationship and shows up as a coloured fringe around
 * cut-outs once the surface is un-premultiplied.
 */

export interface DetailLayer {
  /** Mean-zero high-frequency residual, interleaved RGBA. */
  data: Float32Array;
  width: number;
  height: number;
}

export function extractDetail(src: Surface, sigma = 1): DetailLayer {
  const blurred = blurSurface(src, sigma).data;
  const out = new Float32Array(src.data.length);
  for (let i = 0; i < out.length; i += CHANNELS) {
    out[i] = src.data[i] - blurred[i];
    out[i + 1] = src.data[i + 1] - blurred[i + 1];
    out[i + 2] = src.data[i + 2] - blurred[i + 2];
    out[i + 3] = src.data[i + 3] - blurred[i + 3];
  }
  return { data: out, width: src.width, height: src.height };
}

export interface DetailReconstructOptions {
  /** 0..1. 0 leaves the base untouched, 1 injects the full residual. */
  amount?: number;
  /** Extraction sigma, in source pixels. */
  sigma?: number;
  /**
   * Residual amplitudes above this are attenuated, which stops the layer from
   * re-creating ringing around edges that are already hard.
   */
  clamp?: number;
}

/**
 * Re-inject a detail layer (at source resolution) into a base surface (at
 * output resolution).
 *
 * The layer is scaled up with Mitchell rather than Lanczos on purpose: a
 * ringing kernel applied to a high-pass signal produces ringing about the
 * ringing, which is exactly the artefact this pass exists to avoid.
 */
export function reconstructDetail(
  base: Surface,
  layer: DetailLayer,
  options: DetailReconstructOptions = {},
): Surface {
  const amount = options.amount ?? 0.5;
  if (amount <= 0) return base;
  const clampAt = options.clamp ?? 0.25;

  const layerSurface: Surface = {
    data: layer.data,
    width: layer.width,
    height: layer.height,
    colorSpace: base.colorSpace,
    premultiplied: base.premultiplied,
  };
  const up = resample(layerSurface, base.width, base.height, { kernel: getKernel('mitchell') });

  const out = new Float32Array(base.data);
  const d = up.data;
  for (let i = 0; i < out.length; i += CHANNELS) {
    // One scale factor for the whole pixel, derived from the channel that
    // would clip hardest. Clipping each channel independently would be
    // non-linear per channel and would tint partially transparent pixels.
    let peak = 0;
    for (let c = 0; c < CHANNELS; c++) {
      const magnitude = Math.abs(d[i + c]) * amount;
      if (magnitude > peak) peak = magnitude;
    }
    let factor = amount;
    if (peak > clampAt) {
      // Soft-clip rather than hard-clamp, so there is no visible boundary
      // between clipped and unclipped detail.
      const clipped = clampAt + (peak - clampAt) * 0.25;
      factor = amount * (clipped / peak);
    }
    for (let c = 0; c < CHANNELS; c++) out[i + c] += d[i + c] * factor;
  }

  return {
    data: out,
    width: base.width,
    height: base.height,
    colorSpace: base.colorSpace,
    premultiplied: base.premultiplied,
  };
}

/** Convenience: extract from `source`, inject into `base`. */
export function transferDetail(
  base: Surface,
  source: Surface,
  options: DetailReconstructOptions = {},
): Surface {
  const layer = extractDetail(source, options.sigma ?? 1);
  return reconstructDetail(base, layer, options);
}
