import { antiRing } from '../algorithms/anti-ringing.js';
import { extractDetail, reconstructDetail } from '../algorithms/detail.js';
import { edgeDirectedRefine } from '../algorithms/edge-directed.js';
import { getKernel } from '../algorithms/kernels.js';
import { bilateralDenoise, estimateNoise } from '../algorithms/noise.js';
import { nearestScale, resample, WeightTableCache } from '../algorithms/resample.js';
import { adaptiveSharpen } from '../algorithms/sharpening.js';
import { throwIfAborted } from '../core/errors.js';
import { planScaleSteps, type ResolvedTuning } from '../core/presets.js';
import type { EngineName, RuntimeName, ScaleFactor } from '../core/types.js';
import { clampSurface, toLinear, toSrgb } from '../image/color.js';
import { premultiply, unpremultiply } from '../image/alpha.js';
import type { Surface } from '../image/surface.js';
import { yieldToEventLoop } from '../env/environment.js';
import type { EngineContext, UpscaleEngine } from './types.js';

/**
 * A resampler that can be swapped for a GPU implementation. The classical
 * pipeline is mostly O(n) passes over a buffer; the resample is the one step
 * where a GPU is a large win, so it is the one step that is pluggable.
 */
export interface Resampler {
  readonly runtime: RuntimeName;
  resample(src: Surface, outWidth: number, outHeight: number, kernel: string): Promise<Surface> | Surface;
  dispose?(): void | Promise<void>;
}

export interface ClassicalUpscalerOptions {
  /** GPU or otherwise accelerated resampler. Falls back to CPU on failure. */
  resampler?: Resampler;
}

/**
 * The classical engine.
 *
 * The pipeline, in order, and why each step is where it is:
 *
 *  1. Denoise, at source resolution. Enlarging noise first and smoothing it
 *     afterwards costs 4-64x the work and destroys more real detail.
 *  2. Premultiply, and optionally linearise. Premultiplication is not
 *     optional: filtering straight alpha drags transparent black into the edges
 *     of cut-outs. Linearisation is, and defaults to off - see
 *     `UpscaleOptions.workingSpace` for the measurements behind that.
 *  3. Extract the high-frequency layer, at source resolution, before anything
 *     band-limits it.
 *  4. Resample with a windowed-sinc kernel - the actual enlargement.
 *  5. Anti-ring against the source neighbourhood, undoing the sinc lobes'
 *     overshoot.
 *  6. Edge-directed refinement, removing the staircase a separable kernel
 *     cannot avoid.
 *  7. Re-inject the detail layer at the new resolution.
 *  8. Adaptive sharpening with halo suppression.
 *  9. Clamp, un-premultiply, back to sRGB.
 *
 * For factors above 2x this whole chain runs once per doubling. Detail that
 * has already been re-established at 2x survives the next resample, which a
 * single jump to 8x cannot reproduce.
 */
export class ClassicalUpscaler implements UpscaleEngine {
  readonly name: EngineName = 'classical';
  readonly preferredTileSize = null;
  /**
   * Widest support in the chain: Lanczos-4 needs 4 source pixels, the
   * anti-ring window 2, the detail Gaussian about 3 sigma. 16 covers all of it
   * with room to spare, which is what makes tiled output identical to
   * whole-image output rather than merely close.
   */
  readonly tileOverlap = 16;
  readonly featherTiles = false;

  private resampler: Resampler | undefined;
  private readonly fallbackCache = new WeightTableCache();

  constructor(options: ClassicalUpscalerOptions = {}) {
    this.resampler = options.resampler;
  }

  get runtime(): RuntimeName {
    return this.resampler?.runtime ?? 'cpu';
  }

  async upscaleSurface(
    src: Surface,
    scale: number,
    tuning: ResolvedTuning,
    ctx: EngineContext,
  ): Promise<Surface> {
    throwIfAborted(ctx.signal);

    if (tuning.nearestNeighbour) {
      // Pixel art: no colour-space round trip either, since nearest neighbour
      // never averages two values and so cannot suffer from gamma error.
      return nearestScale(src, scale);
    }

    const steps = isIntegerScale(scale) ? planScaleSteps(scale as ScaleFactor) : [scale];
    const totalWork = steps.reduce((sum, s) => sum + s * s, 0);
    let doneWork = 0;

    let working = this.prepare(src, tuning, ctx);

    for (const step of steps) {
      throwIfAborted(ctx.signal);
      const stepStart = doneWork / totalWork;
      const stepSpan = (step * step) / totalWork;
      working = await this.runStep(working, step, tuning, ctx, stepStart, stepSpan);
      doneWork += step * step;
      // Between passes is a natural yield point: it bounds how long the main
      // thread can be blocked when no Worker is available.
      await yieldToEventLoop();
    }

    return this.finish(working);
  }

  /** Denoise, linearise, premultiply. */
  private prepare(src: Surface, tuning: ResolvedTuning, ctx: EngineContext): Surface {
    let working: Surface = { ...src, data: new Float32Array(src.data) };

    if (tuning.noiseReduction > 0) {
      // Scale the requested amount by how much noise is actually present, so a
      // clean studio shot is not softened by a mode preset. The measurement
      // comes from the controller when there is one: taken per tile it would
      // vary across the grid and denoise each tile by a different amount.
      const measured = ctx.imageStats?.noiseSigma ?? estimateNoise(working);
      const effective = tuning.noiseReduction * Math.min(1, measured / 0.012);
      if (effective > 0.02) {
        ctx.logger.debug(
          `classical: noise sigma ~${measured.toFixed(4)}, denoise amount ${effective.toFixed(2)}`,
        );
        working = bilateralDenoise(working, { amount: effective });
      }
    }

    // Premultiplication happens regardless: it is about compositing, not
    // gamma, and filtering straight alpha fringes cut-outs in either space.
    if (tuning.workingSpace === 'linear') toLinear(working);
    premultiply(working);
    return working;
  }

  /** One resample-and-restore pass at a single scale factor. */
  private async runStep(
    input: Surface,
    step: number,
    tuning: ResolvedTuning,
    ctx: EngineContext,
    stepStart: number,
    stepSpan: number,
  ): Promise<Surface> {
    const report = (fraction: number): void => {
      ctx.reporter.report(ctx.progressBase + ctx.progressSpan * (stepStart + stepSpan * fraction));
    };

    const outWidth = Math.round(input.width * step);
    const outHeight = Math.round(input.height * step);

    const detailLayer = tuning.detail > 0 ? extractDetail(input, tuning.detailSigma) : null;
    report(0.1);
    throwIfAborted(ctx.signal);

    let out = await this.doResample(input, outWidth, outHeight, tuning, ctx);
    report(0.45);
    throwIfAborted(ctx.signal);

    if (tuning.antiRinging > 0) {
      out = antiRing(out, input, { amount: tuning.antiRinging, radius: 2 });
      report(0.6);
      throwIfAborted(ctx.signal);
    }

    if (tuning.edgeDirected > 0) {
      out = edgeDirectedRefine(out, {
        strength: tuning.edgeDirected,
        // The tensor window should cover roughly the same *source* area at
        // every scale, otherwise 8x output gets analysed through a keyhole.
        tensorSigma: 1 + 0.25 * (step - 1),
        radius: Math.max(1, step * 0.75),
      });
      report(0.75);
      throwIfAborted(ctx.signal);
    }

    if (detailLayer && tuning.detail > 0) {
      out = reconstructDetail(out, detailLayer, {
        amount: tuning.detail,
        clamp: 0.25,
      });
      report(0.88);
      throwIfAborted(ctx.signal);
    }

    if (tuning.sharpening > 0) {
      out = adaptiveSharpen(out, {
        amount: tuning.sharpening,
        radius: tuning.sharpenRadius,
        edgeProtection: tuning.edgeProtection,
        haloSuppression: 0.5 + 0.5 * tuning.antiRinging,
      });
    }
    report(1);
    return out;
  }

  private async doResample(
    input: Surface,
    outWidth: number,
    outHeight: number,
    tuning: ResolvedTuning,
    ctx: EngineContext,
  ): Promise<Surface> {
    if (this.resampler) {
      try {
        return await this.resampler.resample(input, outWidth, outHeight, tuning.kernel);
      } catch (error) {
        // A lost GPU device or an over-large allocation must not fail the
        // whole call; drop to CPU permanently and carry on.
        void this.resampler.dispose?.();
        this.resampler = undefined;
        ctx.logger.warn('accelerated resample failed, falling back to CPU', error);
      }
    }
    return resample(input, outWidth, outHeight, {
      kernel: getKernel(tuning.kernel),
      cache: this.fallbackCache,
    });
  }

  /** Un-premultiply, back to sRGB, clamp to a displayable range. */
  private finish(surface: Surface): Surface {
    clampSurface(surface);
    unpremultiply(surface);
    // A no-op when the pipeline stayed in sRGB.
    toSrgb(surface);
    clampSurface(surface);
    return surface;
  }

  async dispose(): Promise<void> {
    await this.resampler?.dispose?.();
    this.resampler = undefined;
    this.fallbackCache.clear();
  }
}

function isIntegerScale(scale: number): boolean {
  return scale === 2 || scale === 3 || scale === 4 || scale === 8;
}
