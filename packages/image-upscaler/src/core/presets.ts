import type { KernelName } from '../algorithms/kernels.js';
import type { ScaleFactor, UpscaleMode, UpscaleOptions } from './types.js';

/**
 * Mode presets.
 *
 * Every mode drives the same pipeline; only these numbers change. Keeping it
 * that way means a mode can never introduce a behaviour the others cannot
 * express, and any of the values stays individually overridable.
 */
export interface ResolvedTuning {
  kernel: KernelName;
  /** See `UpscaleOptions.workingSpace`. */
  workingSpace: 'srgb' | 'linear';
  sharpening: number;
  detail: number;
  noiseReduction: number;
  edgeProtection: number;
  antiRinging: number;
  /** Strength of the edge-directed refinement pass. */
  edgeDirected: number;
  /** Sigma of the detail-extraction high-pass, in source pixels. */
  detailSigma: number;
  /** Radius of the unsharp mask, in output pixels. */
  sharpenRadius: number;
  /** Skip every smoothing filter and magnify by pixel replication. */
  nearestNeighbour: boolean;
}

const PRESETS: Record<UpscaleMode, ResolvedTuning> = {
  // Conservative. Photographs where the goal is "bigger", not "punchier".
  //
  // The strengths here are set from measurement rather than taste. On the
  // benchmark suite the bare resample scores 25.6 dB PSNR / 0.848 SSIM; at
  // sharpening 0.30 / detail 0.35 that fell to 23.6 / 0.825, which is a lot of
  // fidelity for a mode whose whole purpose is to look untouched. At 0.18 /
  // 0.20 it scores 24.6 / 0.837 - still visibly crisper than a plain resize,
  // and within about a decibel of the theoretical best. `balanced` and
  // `detail` are where the deliberately punchier settings live.
  natural: {
    kernel: 'lanczos3',
    workingSpace: 'srgb',
    sharpening: 0.18,
    detail: 0.2,
    noiseReduction: 0.15,
    edgeProtection: 0.6,
    antiRinging: 0.85,
    edgeDirected: 0.6,
    detailSigma: 1,
    sharpenRadius: 0.9,
    nearestNeighbour: false,
  },
  // The default. Visibly crisper than a plain resize without looking processed.
  balanced: {
    kernel: 'lanczos3',
    workingSpace: 'srgb',
    sharpening: 0.45,
    detail: 0.5,
    noiseReduction: 0.2,
    edgeProtection: 0.5,
    antiRinging: 0.8,
    edgeDirected: 0.7,
    detailSigma: 1,
    sharpenRadius: 0.9,
    nearestNeighbour: false,
  },
  // Pushes micro-contrast hard. Good on landscapes and architecture, too much
  // on skin.
  detail: {
    kernel: 'lanczos3',
    workingSpace: 'srgb',
    sharpening: 0.65,
    detail: 0.8,
    noiseReduction: 0.08,
    edgeProtection: 0.35,
    antiRinging: 0.7,
    edgeDirected: 0.75,
    detailSigma: 0.9,
    sharpenRadius: 0.8,
    nearestNeighbour: false,
  },
  // Text and line art: hard edges, no ringing, no grain amplification.
  // Lanczos-4 buys extra edge acuity, and the ringing it would normally cost
  // is bought back by clamping anti-ringing to full strength.
  document: {
    kernel: 'lanczos4',
    workingSpace: 'srgb',
    sharpening: 0.75,
    detail: 0.45,
    noiseReduction: 0.3,
    edgeProtection: 0.25,
    antiRinging: 1,
    edgeDirected: 0.85,
    detailSigma: 1.1,
    sharpenRadius: 0.7,
    nearestNeighbour: false,
  },
  // Pixel art wants pixels. Every filter in the pipeline is a defect here.
  'pixel-art': {
    kernel: 'box',
    // Irrelevant here - nearest neighbour never averages two values, so no
    // colour-space choice can affect it - but set explicitly so the type is
    // satisfied without a cast and the preset reads uniformly.
    workingSpace: 'srgb',
    sharpening: 0,
    detail: 0,
    noiseReduction: 0,
    edgeProtection: 0,
    antiRinging: 0,
    edgeDirected: 0,
    detailSigma: 1,
    sharpenRadius: 1,
    nearestNeighbour: true,
  },
};

export const DEFAULT_MODE: UpscaleMode = 'balanced';

export function getPreset(mode: UpscaleMode = DEFAULT_MODE): ResolvedTuning {
  const preset = PRESETS[mode];
  if (!preset) throw new Error(`Unknown mode: ${mode}`);
  return { ...preset };
}

export function listModes(): UpscaleMode[] {
  return Object.keys(PRESETS) as UpscaleMode[];
}

function clamp01(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Merge a preset with the caller's per-call overrides. */
export function resolveTuning(mode: UpscaleMode | undefined, options: UpscaleOptions): ResolvedTuning {
  const preset = getPreset(mode);
  return {
    ...preset,
    workingSpace: options.workingSpace ?? preset.workingSpace,
    sharpening: clamp01(options.sharpening, preset.sharpening),
    detail: clamp01(options.detail, preset.detail),
    noiseReduction: clamp01(options.noiseReduction, preset.noiseReduction),
    edgeProtection: clamp01(options.edgeProtection, preset.edgeProtection),
    antiRinging: clamp01(options.antiRinging, preset.antiRinging),
  };
}

/**
 * Break a scale factor into a chain of passes.
 *
 * Going straight to 8x in one resample throws away the chance to re-inject
 * detail and re-straighten edges at each intermediate resolution, and the
 * result is measurably softer. Doubling repeatedly costs about 33% more time
 * (1 + 1/4 + 1/16 ... of the final pixel count) and looks better, so anything
 * above 2x that factors cleanly is done in 2x steps.
 */
export function planScaleSteps(scale: ScaleFactor): number[] {
  switch (scale) {
    case 2:
      return [2];
    case 3:
      return [3];
    case 4:
      return [2, 2];
    case 8:
      return [2, 2, 2];
    default: {
      const exhaustive: never = scale;
      throw new Error(`Unsupported scale: ${String(exhaustive)}`);
    }
  }
}

export const SUPPORTED_SCALES: ScaleFactor[] = [2, 3, 4, 8];

export function isSupportedScale(value: unknown): value is ScaleFactor {
  return SUPPORTED_SCALES.includes(value as ScaleFactor);
}
