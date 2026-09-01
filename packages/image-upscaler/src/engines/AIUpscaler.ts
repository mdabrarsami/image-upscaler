import { getKernel } from '../algorithms/kernels.js';
import { resample } from '../algorithms/resample.js';
import { throwIfAborted } from '../core/errors.js';
import type { ResolvedTuning } from '../core/presets.js';
import type { EngineName, RuntimeName } from '../core/types.js';
import { premultiply, unpremultiply, bleedEdges, hasTransparency } from '../image/alpha.js';
import { clampSurface, toLinear, toSrgb } from '../image/color.js';
import { CHANNELS, type Surface } from '../image/surface.js';
import type { AIInferenceSession } from '../ai/AIInference.js';
import type { EngineContext, UpscaleEngine } from './types.js';

/**
 * The AI engine.
 *
 * Two things it deliberately does *not* do:
 *
 *  - Feed alpha to the network. Real-ESRGAN and every comparable
 *    super-resolution model is RGB-only. Alpha is carried separately through a
 *    Lanczos resize, and the RGB under transparent regions is flood-filled
 *    first so the network is never shown the black that sits behind a cut-out.
 *  - Work in linear light. The networks were trained on sRGB-encoded pixels;
 *    linearising the input first would present them with a distribution they
 *    have never seen. The classical passes that surround them do linearise -
 *    which is why the conversion lives in each engine rather than in the
 *    controller.
 */
export class AIUpscaler implements UpscaleEngine {
  readonly name: EngineName = 'ai';
  readonly featherTiles = true;

  private readonly session: AIInferenceSession;

  constructor(session: AIInferenceSession) {
    this.session = session;
  }

  get runtime(): RuntimeName {
    return this.session.runtime;
  }

  get preferredTileSize(): number {
    return this.session.model.preferredTileSize;
  }

  /**
   * Wider than the classical engine's halo. A convolutional network's
   * effective receptive field is not a hard radius, so the halo cannot make
   * tiled output exactly equal whole-image output. It only has to make the
   * difference smaller than the feathered blend can hide.
   */
  get tileOverlap(): number {
    return this.session.model.tileOverlap;
  }

  get modelScale(): number {
    return this.session.model.scale;
  }

  async upscaleSurface(
    src: Surface,
    scale: number,
    tuning: ResolvedTuning,
    ctx: EngineContext,
  ): Promise<Surface> {
    throwIfAborted(ctx.signal);
    const report = (fraction: number): void => {
      ctx.reporter.report(ctx.progressBase + ctx.progressSpan * fraction);
    };

    const transparent = hasTransparency(src);

    // RGB for the network: straight alpha, sRGB, with colour bled outwards so
    // transparent pixels carry a plausible neighbour rather than black.
    const rgbInput: Surface = { ...src, data: new Float32Array(src.data) };
    // A generous number of iterations: the flood is cheap relative to
    // inference, and the further the real colour reaches, the less black is
    // left inside the network's receptive field.
    if (transparent) bleedEdges(rgbInput, 12);
    report(0.05);

    const modelScale = this.session.model.scale;
    let result = await this.session.run(rgbInput);
    report(0.75);
    throwIfAborted(ctx.signal);

    // The network's native factor rarely matches the request exactly. Anything
    // left over is a plain high-quality resize - the alternative, running the
    // network repeatedly, compounds its artefacts.
    const targetWidth = Math.round(src.width * scale);
    const targetHeight = Math.round(src.height * scale);
    if (result.width !== targetWidth || result.height !== targetHeight) {
      ctx.logger.debug(
        `AI model is ${modelScale}x but ${scale}x was requested; resampling ${result.width}x${result.height} to ${targetWidth}x${targetHeight}`,
      );
      toLinear(result);
      premultiply(result);
      result = resample(result, targetWidth, targetHeight, {
        kernel: getKernel(tuning.kernel === 'box' ? 'lanczos3' : tuning.kernel),
        cache: ctx.cache,
      });
      unpremultiply(result);
      toSrgb(result);
    }
    report(0.9);

    if (transparent) {
      applyResampledAlpha(result, src, ctx);
    } else {
      // The network only produced RGB; make the opacity explicit.
      const data = result.data;
      for (let i = 3; i < data.length; i += CHANNELS) data[i] = 1;
    }

    clampSurface(result);
    report(1);
    return result;
  }
}

/**
 * Rebuild the alpha channel by resizing the original one.
 *
 * Done in premultiplied linear space, which is the only way to resize an alpha
 * channel without the edge either eating into the subject or growing a fringe.
 */
function applyResampledAlpha(target: Surface, source: Surface, ctx: EngineContext): void {
  const alphaOnly: Surface = {
    data: new Float32Array(source.data.length),
    width: source.width,
    height: source.height,
    colorSpace: 'linear',
    premultiplied: true,
  };
  // Alpha is not a colour, so it needs no transfer function; putting it in all
  // four channels lets the existing RGBA resampler do the work unchanged.
  for (let i = 0; i < alphaOnly.data.length; i += CHANNELS) {
    const a = source.data[i + 3];
    alphaOnly.data[i] = a;
    alphaOnly.data[i + 1] = a;
    alphaOnly.data[i + 2] = a;
    alphaOnly.data[i + 3] = a;
  }

  const upscaled = resample(alphaOnly, target.width, target.height, {
    kernel: getKernel('lanczos3'),
    cache: ctx.cache,
  });

  const dst = target.data;
  const src = upscaled.data;
  for (let i = 3; i < dst.length; i += CHANNELS) {
    const a = src[i];
    dst[i] = a < 0 ? 0 : a > 1 ? 1 : a;
  }
}
