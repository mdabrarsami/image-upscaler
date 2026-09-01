import { CHANNELS, type Surface } from '../image/surface.js';
import { lumaPlane } from '../image/color.js';
import { blurPlane } from './gaussian.js';
import { gradient, structureTensor } from './edges.js';

/**
 * Edge-directed refinement.
 *
 * A separable kernel cannot know about orientation: it filters along x and y,
 * so a 30-degree edge comes out of any linear resize with visible stair steps.
 * This pass runs *after* the base resample and fixes that locally.
 *
 * For each pixel the structure tensor gives an edge tangent and an anisotropy
 * score. Where anisotropy is high the pixel is replaced by a short 1-D average
 * taken *along* the tangent, which removes the staircase without crossing the
 * edge, plus a mild 1-D unsharp *across* the normal to put back the acuity the
 * tangential average costs. Where anisotropy is low (texture, noise, flat
 * areas) the blend weight falls to zero and the base pixel survives untouched
 * — steering texture along a meaningless "dominant direction" is what makes
 * naive edge-directed filters look waxy.
 *
 * This is DDT/warp-style refinement, not NEDI: it does not re-derive the
 * interpolation weights from local covariance. It is a great deal cheaper and,
 * on top of Lanczos-3, visually competitive.
 */
export interface EdgeDirectedOptions {
  /** 0..1 overall blend weight. */
  strength?: number;
  /** Anisotropy below this is treated as texture and left alone. */
  anisotropyThreshold?: number;
  /** Ignore edges weaker than this (tensor eigenvalue). Suppresses noise. */
  strengthThreshold?: number;
  /** Sampling radius along the tangent, in output pixels. */
  radius?: number;
  /** 0..1 amount of cross-edge sharpening applied with the tangential blur. */
  crossSharpen?: number;
  /** Tensor smoothing sigma, in output pixels. Scale it with the zoom factor. */
  tensorSigma?: number;
}

/** Bilinear fetch with clamped edges, on interleaved RGBA. */
function sampleBilinear(
  data: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
  out: Float32Array,
): void {
  const cx = x < 0 ? 0 : x > width - 1 ? width - 1 : x;
  const cy = y < 0 ? 0 : y > height - 1 ? height - 1 : y;
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = x0 + 1 > width - 1 ? width - 1 : x0 + 1;
  const y1 = y0 + 1 > height - 1 ? height - 1 : y0 + 1;
  const fx = cx - x0;
  const fy = cy - y0;

  const i00 = (y0 * width + x0) * CHANNELS;
  const i10 = (y0 * width + x1) * CHANNELS;
  const i01 = (y1 * width + x0) * CHANNELS;
  const i11 = (y1 * width + x1) * CHANNELS;

  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;

  for (let c = 0; c < CHANNELS; c++) {
    out[c] = data[i00 + c] * w00 + data[i10 + c] * w10 + data[i01 + c] * w01 + data[i11 + c] * w11;
  }
}

export function edgeDirectedRefine(src: Surface, options: EdgeDirectedOptions = {}): Surface {
  const strength = options.strength ?? 0.7;
  if (strength <= 0) return src;

  const anisoT = options.anisotropyThreshold ?? 0.25;
  const strengthT = options.strengthThreshold ?? 2e-4;
  const radius = options.radius ?? 1.5;
  const crossSharpen = options.crossSharpen ?? 0.35;
  const tensorSigma = options.tensorSigma ?? 1.2;

  const { width, height, data } = src;
  const luma = lumaPlane(src);
  const field = gradient(luma, width, height, 'scharr');
  const tensor = structureTensor(field, tensorSigma, blurPlane);
  const { jxx, jxy, jyy } = tensor;

  const out = new Float32Array(data);
  const s0 = new Float32Array(CHANNELS);
  const s1 = new Float32Array(CHANNELS);
  const n0 = new Float32Array(CHANNELS);
  const n1 = new Float32Array(CHANNELS);

  const invAnisoRange = 1 / Math.max(1e-6, 1 - anisoT);

  // The tensor is decomposed inline rather than through `analyzeTensor`.
  // Anisotropy needs only the two eigenvalues, but the eigen*vector* needs a
  // square root and a normalisation, and on a typical image nine pixels in ten
  // fail the anisotropy test and never use it. Deciding first and computing
  // second turned this pass from the most expensive one into a middling one.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;

      const a = jxx[p];
      const b = jxy[p];
      const c = jyy[p];
      const trace = a + c;
      const diff = a - c;
      const disc = Math.sqrt(diff * diff + 4 * b * b);
      const l1 = (trace + disc) * 0.5;
      if (l1 < strengthT) continue;

      const l2 = (trace - disc) * 0.5;
      const aniso = trace > 1e-12 ? (l1 - l2) / (l1 + l2 + 1e-12) : 0;
      if (aniso <= anisoT) continue;

      // Ramp the weight in from the threshold so there is no visible switch
      // between "refined" and "untouched" pixels.
      const t = (aniso - anisoT) * invAnisoRange;
      const w = strength * (t < 0 ? 0 : t > 1 ? 1 : t);

      // Eigenvector for l1 points across the edge; rotate 90 degrees to get
      // the direction to interpolate along.
      let ex = b;
      let ey = l1 - a;
      if (ex > -1e-12 && ex < 1e-12 && ey > -1e-12 && ey < 1e-12) {
        ex = 1;
        ey = 0;
      }
      const len = Math.sqrt(ex * ex + ey * ey);
      const tx = -ey / len;
      const ty = ex / len;

      sampleBilinear(data, width, height, x + tx * radius, y + ty * radius, s0);
      sampleBilinear(data, width, height, x - tx * radius, y - ty * radius, s1);

      // Normal direction (across the edge) for the corrective sharpen.
      const nx = -ty;
      const ny = tx;
      sampleBilinear(data, width, height, x + nx * radius, y + ny * radius, n0);
      sampleBilinear(data, width, height, x - nx * radius, y - ny * radius, n1);

      const i = p * CHANNELS;
      for (let ch = 0; ch < CHANNELS; ch++) {
        const center = data[i + ch];
        const tangential = (s0[ch] + 2 * center + s1[ch]) * 0.25;
        const crossMean = (n0[ch] + n1[ch]) * 0.5;
        let refined = tangential + crossSharpen * (center - crossMean);

        // Clamp to the range of the pixels this refinement actually looked at.
        // The tangential average is inside that range by construction, but the
        // cross-edge sharpening term is not: on an axis-aligned edge it pushes
        // the pixel further out, deepening the ringing the anti-ring pass just
        // removed. Straightening an edge should never create a new extreme.
        // `lo` and `hi` both start at `center`, so `lo <= center <= hi` holds
        // throughout and no sample can be below `lo` and above `hi` at once -
        // which is what makes the `else if` chain correct as well as cheaper.
        let lo = center;
        let hi = center;
        const va = s0[ch];
        const vb = s1[ch];
        const vc = n0[ch];
        const vd = n1[ch];
        if (va < lo) lo = va;
        else if (va > hi) hi = va;
        if (vb < lo) lo = vb;
        else if (vb > hi) hi = vb;
        if (vc < lo) lo = vc;
        else if (vc > hi) hi = vc;
        if (vd < lo) lo = vd;
        else if (vd > hi) hi = vd;
        if (refined < lo) refined = lo;
        else if (refined > hi) refined = hi;

        out[i + ch] = center + w * (refined - center);
      }
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
