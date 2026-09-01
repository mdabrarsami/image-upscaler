/**
 * Gradient operators and the derived edge statistics the rest of the pipeline
 * steers on: where to sharpen, where to protect, where ringing is likely.
 *
 * All of these work on a single-channel plane (normally luma) rather than RGB.
 * Edge structure is a luminance phenomenon, and running one plane instead of
 * three is three times cheaper for an indistinguishable result.
 */

export interface GradientField {
  /** d/dx, same length as the input plane. */
  gx: Float32Array;
  /** d/dy. */
  gy: Float32Array;
  width: number;
  height: number;
}

export type GradientOperator = 'sobel' | 'scharr';

// Separable forms: the 3x3 operator is (smooth) x (derivative).
const SOBEL_SMOOTH = [1, 2, 1] as const;
const SCHARR_SMOOTH = [3, 10, 3] as const;
const DERIV = [-1, 0, 1] as const;
// Normalisation so a unit step yields a gradient magnitude of 1.
const SOBEL_NORM = 1 / 8;
const SCHARR_NORM = 1 / 32;

function clampIdx(v: number, max: number): number {
  return v < 0 ? 0 : v > max ? max : v;
}

/**
 * Sobel is the cheap, slightly rotation-biased classic. Scharr has markedly
 * better rotational symmetry at the same 3x3 cost, which matters when the
 * gradient *direction* drives interpolation, so it is the default for the
 * edge-directed path.
 */
export function gradient(
  plane: Float32Array,
  width: number,
  height: number,
  operator: GradientOperator = 'scharr',
): GradientField {
  const smooth = operator === 'sobel' ? SOBEL_SMOOTH : SCHARR_SMOOTH;
  const norm = operator === 'sobel' ? SOBEL_NORM : SCHARR_NORM;
  const gx = new Float32Array(width * height);
  const gy = new Float32Array(width * height);

  const maxX = width - 1;
  const maxY = height - 1;

  // Horizontal derivative: derivative along x, smoothing along y.
  const tmpDx = new Float32Array(width * height);
  const tmpSx = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const l = plane[row + clampIdx(x - 1, maxX)];
      const c = plane[row + x];
      const r = plane[row + clampIdx(x + 1, maxX)];
      tmpDx[row + x] = DERIV[0] * l + DERIV[2] * r;
      tmpSx[row + x] = smooth[0] * l + smooth[1] * c + smooth[2] * r;
    }
  }
  for (let y = 0; y < height; y++) {
    const rowUp = clampIdx(y - 1, maxY) * width;
    const row = y * width;
    const rowDn = clampIdx(y + 1, maxY) * width;
    for (let x = 0; x < width; x++) {
      gx[row + x] =
        (smooth[0] * tmpDx[rowUp + x] + smooth[1] * tmpDx[row + x] + smooth[2] * tmpDx[rowDn + x]) *
        norm;
      gy[row + x] =
        (DERIV[0] * tmpSx[rowUp + x] + DERIV[2] * tmpSx[rowDn + x]) * norm;
    }
  }

  return { gx, gy, width, height };
}

export function gradientMagnitude(field: GradientField): Float32Array {
  const { gx, gy } = field;
  const out = new Float32Array(gx.length);
  // `Math.sqrt` of the sum of squares rather than `Math.hypot`. Hypot is
  // carefully written to avoid intermediate overflow, which costs several times
  // as much and buys nothing for gradients of values in 0..1.
  for (let i = 0; i < gx.length; i++) {
    const x = gx[i];
    const y = gy[i];
    out[i] = Math.sqrt(x * x + y * y);
  }
  return out;
}

/** Edge orientation in radians, in [-pi/2, pi/2). */
export function gradientOrientation(field: GradientField): Float32Array {
  const { gx, gy } = field;
  const out = new Float32Array(gx.length);
  for (let i = 0; i < gx.length; i++) out[i] = Math.atan2(gy[i], gx[i]);
  return out;
}

export interface StructureTensor {
  /** Smoothed gx*gx, gx*gy, gy*gy. */
  jxx: Float32Array;
  jxy: Float32Array;
  jyy: Float32Array;
  width: number;
  height: number;
}

/**
 * Structure tensor, smoothed over a small window.
 *
 * The raw gradient tells you the direction of *this* pixel's step; the tensor
 * tells you the dominant orientation of the neighbourhood, and crucially
 * distinguishes an edge (one strong eigenvalue) from a corner or texture (two).
 * Edge-directed interpolation needs that distinction — steering along a
 * spurious direction in a textured region is what produces the smeared,
 * plasticky look.
 */
export function structureTensor(
  field: GradientField,
  smoothingSigma = 1,
  blur: (src: Float32Array, w: number, h: number, sigma: number) => Float32Array,
): StructureTensor {
  const { gx, gy, width, height } = field;
  const n = gx.length;
  const jxx = new Float32Array(n);
  const jxy = new Float32Array(n);
  const jyy = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    jxx[i] = gx[i] * gx[i];
    jxy[i] = gx[i] * gy[i];
    jyy[i] = gy[i] * gy[i];
  }
  return {
    jxx: blur(jxx, width, height, smoothingSigma),
    jxy: blur(jxy, width, height, smoothingSigma),
    jyy: blur(jyy, width, height, smoothingSigma),
    width,
    height,
  };
}

export interface TensorAnalysis {
  /** Unit vector along the edge (the *low* variance direction). */
  dirX: Float32Array;
  dirY: Float32Array;
  /** (l1 - l2) / (l1 + l2). 0 = isotropic texture, 1 = a clean edge. */
  anisotropy: Float32Array;
  /** Larger eigenvalue: edge strength. */
  strength: Float32Array;
}

export function analyzeTensor(tensor: StructureTensor): TensorAnalysis {
  const { jxx, jxy, jyy } = tensor;
  const n = jxx.length;
  const dirX = new Float32Array(n);
  const dirY = new Float32Array(n);
  const anisotropy = new Float32Array(n);
  const strength = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const a = jxx[i];
    const b = jxy[i];
    const c = jyy[i];
    const trace = a + c;
    const diff = a - c;
    const disc = Math.sqrt(diff * diff + 4 * b * b);
    const l1 = (trace + disc) / 2;
    const l2 = (trace - disc) / 2;
    strength[i] = l1;
    anisotropy[i] = trace > 1e-12 ? (l1 - l2) / (l1 + l2 + 1e-12) : 0;

    // Eigenvector for l1 points across the edge; rotate 90 degrees to get the
    // direction to interpolate *along*.
    let ex = b;
    let ey = l1 - a;
    if (Math.abs(ex) < 1e-12 && Math.abs(ey) < 1e-12) {
      ex = 1;
      ey = 0;
    }
    const len = Math.sqrt(ex * ex + ey * ey);
    dirX[i] = -ey / len;
    dirY[i] = ex / len;
  }

  return { dirX, dirY, anisotropy, strength };
}
