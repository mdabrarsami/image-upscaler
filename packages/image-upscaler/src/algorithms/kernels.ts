/**
 * Separable reconstruction kernels.
 *
 * Every function takes a distance in *source* pixels and returns a weight.
 * `support` is the radius outside which the kernel is exactly zero.
 */
export interface FilterKernel {
  readonly name: string;
  readonly support: number;
  (x: number): number;
}

function sinc(x: number): number {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

function makeKernel(name: string, support: number, fn: (x: number) => number): FilterKernel {
  // `defineProperty`, not `Object.assign`: a function's own `name` is
  // non-writable, so a plain assignment throws in strict mode.
  Object.defineProperty(fn, 'name', { value: name, configurable: true });
  Object.defineProperty(fn, 'support', { value: support, enumerable: true });
  return fn as FilterKernel;
}

/**
 * Nearest neighbour. The right answer for pixel art at integer scales.
 *
 * The comparison is strict, not `<=`: an inclusive bound makes both taps fire
 * at a half-integer phase, and the normaliser would then average them - which
 * is bilinear, exactly the thing a caller reaching for `box` is avoiding.
 */
export const box: FilterKernel = makeKernel('box', 0.5, (x) => (Math.abs(x) < 0.5 ? 1 : 0));

/** Triangle / tent filter. */
export const bilinear: FilterKernel = makeKernel('bilinear', 1, (x) => {
  const a = Math.abs(x);
  return a < 1 ? 1 - a : 0;
});

/**
 * Keys' parametric cubic. B = 0, C = 0.5 gives Catmull-Rom, the "bicubic"
 * most image editors mean.
 */
export function cubicBC(B: number, C: number, name = `cubic(${B},${C})`): FilterKernel {
  return makeKernel(name, 2, (x) => {
    const a = Math.abs(x);
    const a2 = a * a;
    const a3 = a2 * a;
    if (a < 1) {
      return ((12 - 9 * B - 6 * C) * a3 + (-18 + 12 * B + 6 * C) * a2 + (6 - 2 * B)) / 6;
    }
    if (a < 2) {
      return (
        ((-B - 6 * C) * a3 + (6 * B + 30 * C) * a2 + (-12 * B - 48 * C) * a + (8 * B + 24 * C)) / 6
      );
    }
    return 0;
  });
}

export const bicubic: FilterKernel = cubicBC(0, 0.5, 'bicubic');
/** Mitchell-Netravali. Softer than Catmull-Rom, noticeably less ringing. */
export const mitchell: FilterKernel = cubicBC(1 / 3, 1 / 3, 'mitchell');

export function lanczos(a: number): FilterKernel {
  return makeKernel(`lanczos${a}`, a, (x) => {
    const ax = Math.abs(x);
    if (ax >= a) return 0;
    if (ax === 0) return 1;
    return sinc(x) * sinc(x / a);
  });
}

export const lanczos2: FilterKernel = lanczos(2);
export const lanczos3: FilterKernel = lanczos(3);
export const lanczos4: FilterKernel = lanczos(4);

export type KernelName =
  | 'box'
  | 'bilinear'
  | 'bicubic'
  | 'mitchell'
  | 'lanczos2'
  | 'lanczos3'
  | 'lanczos4';

const REGISTRY: Record<KernelName, FilterKernel> = {
  box,
  bilinear,
  bicubic,
  mitchell,
  lanczos2,
  lanczos3,
  lanczos4,
};

export function getKernel(name: KernelName): FilterKernel {
  const kernel = REGISTRY[name];
  if (!kernel) throw new Error(`Unknown kernel: ${name}`);
  return kernel;
}

/**
 * Precomputed contributions for one axis.
 *
 * Layout is flat and fixed-stride so the resampling inner loop stays free of
 * per-output-pixel allocation: output pixel `i` reads `taps` weights starting
 * at `i * taps`, sampling source pixels from `starts[i]`.
 */
export interface WeightTable {
  readonly taps: number;
  readonly starts: Int32Array;
  readonly weights: Float32Array;
  readonly outputSize: number;
  readonly inputSize: number;
}

/**
 * Build the weight table mapping `inputSize` source pixels to `outputSize`
 * destination pixels.
 *
 * Uses the standard half-pixel-centred mapping. When downscaling the kernel is
 * stretched by the scale ratio so it acts as a proper low-pass filter instead
 * of point-sampling and aliasing.
 */
export function buildWeightTable(
  kernel: FilterKernel,
  inputSize: number,
  outputSize: number,
): WeightTable {
  const ratio = outputSize / inputSize;
  const filterScale = ratio < 1 ? 1 / ratio : 1;
  const support = kernel.support * filterScale;
  const taps = Math.max(1, Math.ceil(support * 2));

  const starts = new Int32Array(outputSize);
  const weights = new Float32Array(outputSize * taps);
  const invFilterScale = 1 / filterScale;

  for (let i = 0; i < outputSize; i++) {
    // Centre of output pixel i, expressed in source coordinates.
    const center = (i + 0.5) / ratio - 0.5;
    // Fixed-width window; out-of-range taps are resolved by edge clamping at
    // sample time, which keeps the stride uniform.
    const start = Math.ceil(center - support);
    starts[i] = start;

    let sum = 0;
    const base = i * taps;
    for (let t = 0; t < taps; t++) {
      const w = kernel((start + t - center) * invFilterScale);
      weights[base + t] = w;
      sum += w;
    }
    // Normalise so flat regions keep their exact value. Windowed-sinc kernels
    // do not sum to 1 at arbitrary sub-pixel phases.
    if (sum !== 0) {
      const inv = 1 / sum;
      for (let t = 0; t < taps; t++) weights[base + t] *= inv;
    } else {
      weights[base + (taps >> 1)] = 1;
    }
  }

  return { taps, starts, weights, outputSize, inputSize };
}
