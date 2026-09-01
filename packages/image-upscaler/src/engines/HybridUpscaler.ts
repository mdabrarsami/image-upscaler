import { antiRingLocal } from '../algorithms/anti-ringing.js';
import { extractDetail, reconstructDetail } from '../algorithms/detail.js';
import { adaptiveSharpen } from '../algorithms/sharpening.js';
import { throwIfAborted } from '../core/errors.js';
import type { ResolvedTuning } from '../core/presets.js';
import type { EngineName, RuntimeName } from '../core/types.js';
import { premultiply, unpremultiply } from '../image/alpha.js';
import { clampSurface, toLinear, toSrgb } from '../image/color.js';
import type { Surface } from '../image/surface.js';
import type { AIUpscaler } from './AIUpscaler.js';
import type { EngineContext, UpscaleEngine } from './types.js';

/**
 * The hybrid engine.
 *
 * A GAN-based super-resolution network invents plausible texture. That is what
 * makes it look good on hair and foliage, and what makes it look wrong on
 * anything the viewer knows the ground truth for - it will confidently
 * hallucinate serifs onto a sans-serif letterform, or smooth a face into
 * plastic.
 *
 * The hybrid path keeps the network's structural reconstruction and puts the
 * *real* high-frequency content of the source back on top of it. The detail
 * layer comes from the original pixels, so where the source had genuine
 * texture the output shows that texture rather than a synthesised
 * approximation, and where it had none, nothing is added.
 *
 * A local anti-ring clamp against the network's own output then stops the
 * re-injected layer from creating overshoot at edges the network already made
 * hard.
 */
export class HybridUpscaler implements UpscaleEngine {
  readonly name: EngineName = 'hybrid';

  private readonly ai: AIUpscaler;

  constructor(ai: AIUpscaler) {
    this.ai = ai;
  }

  get runtime(): RuntimeName {
    return this.ai.runtime;
  }

  get preferredTileSize(): number {
    return this.ai.preferredTileSize;
  }

  get tileOverlap(): number {
    // The classical passes need their own halo on top of the network's.
    return this.ai.tileOverlap + 16;
  }

  get featherTiles(): boolean {
    return true;
  }

  async upscaleSurface(
    src: Surface,
    scale: number,
    tuning: ResolvedTuning,
    ctx: EngineContext,
  ): Promise<Surface> {
    // The AI stage gets the bulk of the progress budget because it is the bulk
    // of the time - the refinement passes are a few percent of the total.
    const aiSpan = ctx.progressSpan * 0.85;
    const aiResult = await this.ai.upscaleSurface(src, scale, tuning, {
      ...ctx,
      progressSpan: aiSpan,
    });
    throwIfAborted(ctx.signal);

    const report = (fraction: number): void => {
      ctx.reporter.report(ctx.progressBase + aiSpan + (ctx.progressSpan - aiSpan) * fraction);
    };

    // Everything below runs in the same working space as the classical
    // engine; the AI stage handed back sRGB with straight alpha.
    const base: Surface = { ...aiResult, data: aiResult.data };
    if (tuning.workingSpace === 'linear') toLinear(base);
    premultiply(base);

    const reference: Surface = { ...src, data: new Float32Array(src.data) };
    if (tuning.workingSpace === 'linear') toLinear(reference);
    premultiply(reference);

    let out = base;
    if (tuning.detail > 0) {
      const layer = extractDetail(reference, tuning.detailSigma);
      // Lighter than the classical engine's injection: the network has already
      // produced high-frequency content, and stacking both over-textures the
      // result.
      out = reconstructDetail(out, layer, { amount: tuning.detail * 0.55, clamp: 0.18 });
      out = antiRingLocal(out, base, 0.6, 1);
      report(0.5);
      throwIfAborted(ctx.signal);
    }

    if (tuning.sharpening > 0) {
      out = adaptiveSharpen(out, {
        amount: tuning.sharpening * 0.5,
        radius: tuning.sharpenRadius,
        edgeProtection: Math.max(0.4, tuning.edgeProtection),
        haloSuppression: 0.7,
      });
    }

    clampSurface(out);
    unpremultiply(out);
    toSrgb(out);
    clampSurface(out);
    report(1);
    return out;
  }
}
