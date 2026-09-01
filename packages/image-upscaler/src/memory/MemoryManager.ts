import { UpscalerError } from '../core/errors.js';
import { surfaceBytes } from '../image/surface.js';

/**
 * Memory planning.
 *
 * Browsers give no reliable way to ask how much memory is left, and an
 * allocation that fails does not always throw - it can take the tab down. So
 * the strategy is to estimate the pipeline peak up front, compare it against a
 * conservative budget, and tile before getting anywhere near the edge.
 */

export interface MemoryBudget {
  /** Bytes the pipeline may use for intermediate buffers. */
  budget: number;
  /** Whether the number came from a real browser signal. */
  reported: boolean;
}

/**
 * `navigator.deviceMemory` is coarse (rounded to 0.5/1/2/4/8 GiB) and capped at
 * 8 on most browsers, and Firefox and Safari do not implement it at all. It is
 * still the only signal available, so it is used as an upper bound with a large
 * safety margin rather than as a measurement.
 */
export function estimateMemoryBudget(): MemoryBudget {
  const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { deviceMemory?: number }) : undefined;
  const deviceMemoryGb = nav?.deviceMemory;
  if (typeof deviceMemoryGb === 'number' && deviceMemoryGb > 0) {
    // A tab should not plan to use more than about an eighth of system memory
    // for scratch buffers.
    return { budget: deviceMemoryGb * 1024 * 1024 * 1024 * 0.125, reported: true };
  }
  // No signal: assume a modest 4 GiB machine and take the same eighth.
  return { budget: 512 * 1024 * 1024, reported: false };
}

/**
 * How many full-size intermediate surfaces each engine holds live at peak.
 *
 * Counted from the actual pipelines rather than guessed: the classical path
 * keeps the base resample, the anti-ringing copy, and one working copy; the
 * detail and sharpen passes each allocate one more but release the previous.
 * AI additionally holds NCHW input and output tensors.
 */
const PEAK_OUTPUT_SURFACES = {
  classical: 3,
  ai: 2,
  hybrid: 4,
} as const;

const PEAK_SOURCE_SURFACES = {
  classical: 2,
  ai: 3,
  hybrid: 3,
} as const;

export interface MemoryEstimate {
  /** Peak bytes if the image were processed in one piece. */
  peakBytes: number;
  budget: number;
  /** True when a single-pass run is expected to fit. */
  fits: boolean;
}

export function estimateProcessingMemory(
  srcWidth: number,
  srcHeight: number,
  scale: number,
  engine: keyof typeof PEAK_OUTPUT_SURFACES,
  budget = estimateMemoryBudget().budget,
): MemoryEstimate {
  const outW = Math.round(srcWidth * scale);
  const outH = Math.round(srcHeight * scale);
  const peakBytes =
    surfaceBytes(srcWidth, srcHeight) * PEAK_SOURCE_SURFACES[engine] +
    surfaceBytes(outW, outH) * PEAK_OUTPUT_SURFACES[engine];
  return { peakBytes, budget, fits: peakBytes <= budget };
}

/**
 * Largest source-tile edge that keeps the per-tile peak inside `budget`.
 *
 * The output surface itself always has to exist, so it is subtracted from the
 * budget first. If even that does not fit, tiling cannot help and the caller
 * gets `OUT_OF_MEMORY`.
 */
export function chooseTileSize(
  srcWidth: number,
  srcHeight: number,
  scale: number,
  engine: keyof typeof PEAK_OUTPUT_SURFACES,
  options: { budget?: number; min?: number; max?: number; overlap?: number } = {},
): number {
  const budget = options.budget ?? estimateMemoryBudget().budget;
  const min = options.min ?? 64;
  const max = options.max ?? 1024;
  const overlap = options.overlap ?? 16;

  const outW = Math.round(srcWidth * scale);
  const outH = Math.round(srcHeight * scale);
  // The full-size destination plus the decoded source are unavoidable.
  const fixed = surfaceBytes(outW, outH) + surfaceBytes(srcWidth, srcHeight);
  const scratch = budget - fixed;

  if (scratch < surfaceBytes(min + overlap * 2, min + overlap * 2) * 6) {
    throw new UpscalerError(
      'OUT_OF_MEMORY',
      `A ${outW}x${outH} result needs about ${formatBytes(fixed)}, which exceeds the ` +
        `estimated ${formatBytes(budget)} budget. Try a smaller scale factor.`,
      { details: { requiredBytes: fixed, budget, outputWidth: outW, outputHeight: outH } },
    );
  }

  // Per source tile of edge `t`, the peak is the padded source tile plus its
  // upscaled counterpart, times the engine multipliers.
  const perTile = (t: number): number => {
    const padded = t + overlap * 2;
    return (
      surfaceBytes(padded, padded) * PEAK_SOURCE_SURFACES[engine] +
      surfaceBytes(Math.round(padded * scale), Math.round(padded * scale)) *
        PEAK_OUTPUT_SURFACES[engine]
    );
  };

  let size = max;
  while (size > min && perTile(size) > scratch) {
    size = Math.floor(size / 2);
  }
  return Math.max(min, Math.min(max, size));
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

/**
 * Hard ceiling on output geometry. Not a policy limit - it is where
 * `Float32Array` indexing and canvas backing stores actually stop working.
 */
export const MAX_OUTPUT_PIXELS = 268_435_456; // 16384 x 16384

export function assertOutputSize(width: number, height: number): void {
  if (width * height > MAX_OUTPUT_PIXELS) {
    throw new UpscalerError(
      'IMAGE_TOO_LARGE',
      `Output ${width}x${height} exceeds the ${MAX_OUTPUT_PIXELS.toLocaleString()} pixel ceiling`,
      { details: { width, height, maxPixels: MAX_OUTPUT_PIXELS } },
    );
  }
}
