import { describe, expect, it } from 'vitest';
import { ClassicalUpscaler } from '../../packages/image-upscaler/src/engines/ClassicalUpscaler.js';
import type {
  EngineContext,
  ImageStatistics,
} from '../../packages/image-upscaler/src/engines/types.js';
import { WeightTableCache } from '../../packages/image-upscaler/src/algorithms/resample.js';
import { estimateNoise } from '../../packages/image-upscaler/src/algorithms/noise.js';
import { ProgressReporter } from '../../packages/image-upscaler/src/core/progress.js';
import { getPreset } from '../../packages/image-upscaler/src/core/presets.js';
import { silentLogger } from '../../packages/image-upscaler/src/core/logger.js';
import { CancellationError } from '../../packages/image-upscaler/src/core/errors.js';
import {
  blitRegion,
  createSurface,
  extractRegion,
  type Surface,
} from '../../packages/image-upscaler/src/image/surface.js';
import { planTiles } from '../../packages/image-upscaler/src/memory/TileManager.js';
import { hasTransparency } from '../../packages/image-upscaler/src/image/alpha.js';
import {
  channelRange,
  fineLines,
  gradient,
  maxAbsDiff,
  mse,
  noisyGradient,
  pixelArt,
  psnr,
  solid,
  ssim,
  textLike,
  transparentDisc,
  verticalEdge,
} from '../fixtures/synthetic.js';

function makeContext(overrides: Partial<EngineContext> = {}): EngineContext {
  return {
    reporter: new ProgressReporter(),
    cache: new WeightTableCache(),
    logger: silentLogger,
    progressBase: 0,
    progressSpan: 1,
    ...overrides,
  };
}

function statsFor(source: Surface): ImageStatistics {
  return { noiseSigma: estimateNoise(source) };
}

const engine = new ClassicalUpscaler();

describe('classical pipeline', () => {
  it('produces the expected geometry at every supported factor', async () => {
    const src = gradient(32, 24);
    for (const scale of [2, 3, 4, 8]) {
      const out = await engine.upscaleSurface(src, scale, getPreset('balanced'), makeContext());
      expect([out.width, out.height], `x${scale}`).toEqual([32 * scale, 24 * scale]);
    }
  });

  it('returns sRGB with straight alpha, as the engine contract requires', async () => {
    const out = await engine.upscaleSurface(
      transparentDisc(32, 10),
      2,
      getPreset('balanced'),
      makeContext(),
    );
    expect(out.colorSpace).toBe('srgb');
    expect(out.premultiplied).toBe(false);
  });

  it('keeps every channel inside 0..1', async () => {
    // A caller encoding this straight to 8-bit must not see wrapped values.
    for (const mode of ['natural', 'balanced', 'detail', 'document'] as const) {
      const out = await engine.upscaleSurface(
        textLike(48, 32),
        4,
        getPreset(mode),
        makeContext(),
      );
      const { min, max } = channelRange(out);
      expect(min, `${mode} min`).toBeGreaterThanOrEqual(0);
      expect(max, `${mode} max`).toBeLessThanOrEqual(1);
    }
  });

  it('preserves a solid colour through the whole chain', async () => {
    const out = await engine.upscaleSurface(
      solid(32, 32, [0.3, 0.55, 0.8, 1]),
      4,
      getPreset('detail'),
      makeContext(),
    );
    for (let i = 0; i < out.data.length; i += 4) {
      expect(out.data[i]).toBeCloseTo(0.3, 3);
      expect(out.data[i + 1]).toBeCloseTo(0.55, 3);
      expect(out.data[i + 2]).toBeCloseTo(0.8, 3);
      expect(out.data[i + 3]).toBeCloseTo(1, 5);
    }
  });

  it('preserves transparency and does not fringe', async () => {
    const src = transparentDisc(48, 16);
    const out = await engine.upscaleSurface(src, 2, getPreset('balanced'), makeContext());
    expect(hasTransparency(out)).toBe(true);

    // Partially transparent pixels must stay red, not go dark.
    let worst = 0;
    for (let i = 0; i < out.data.length; i += 4) {
      const a = out.data[i + 3];
      if (a > 0.2 && a < 0.8) worst = Math.max(worst, 1 - out.data[i]);
    }
    expect(worst).toBeLessThan(0.15);
  });

  it('beats a plain lanczos resize on a downscale-and-recover test', async () => {
    // The only honest way to score an upscaler: take a known original, shrink
    // it, enlarge it back, and measure against the original.
    const original = textLike(96, 96);
    const small = await shrink(original, 2);

    const pipeline = await engine.upscaleSurface(
      small,
      2,
      getPreset('document'),
      makeContext({ imageStats: statsFor(small) }),
    );
    const plain = await plainResize(small, 2);

    expect(psnr(pipeline, original)).toBeGreaterThan(psnr(plain, original));
    expect(ssim(pipeline, original)).toBeGreaterThan(ssim(plain, original));
  });

  it('recovers more structure than a plain resize on fine lines too', async () => {
    const original = fineLines(96, 96, 6);
    const small = await shrink(original, 2);
    const pipeline = await engine.upscaleSurface(
      small,
      2,
      getPreset('detail'),
      makeContext({ imageStats: statsFor(small) }),
    );
    const plain = await plainResize(small, 2);
    expect(mse(pipeline, original)).toBeLessThan(mse(plain, original));
  });

  it('pixel-art mode replicates pixels and invents no colours', async () => {
    const src = pixelArt(16, 16);
    const out = await engine.upscaleSurface(src, 4, getPreset('pixel-art'), makeContext());

    const palette = new Set<string>();
    for (let i = 0; i < src.data.length; i += 4) palette.add(src.data.slice(i, i + 3).join(','));
    for (let i = 0; i < out.data.length; i += 4) {
      expect(palette.has(out.data.slice(i, i + 3).join(','))).toBe(true);
    }
  });

  it('mode presets order themselves by the sharpness they produce', async () => {
    const src = await shrink(textLike(96, 96), 2);
    const acuity = async (mode: 'natural' | 'balanced' | 'detail'): Promise<number> => {
      const out = await engine.upscaleSurface(
        src,
        2,
        getPreset(mode),
        makeContext({ imageStats: statsFor(src) }),
      );
      const { min, max } = channelRange(out);
      return max - min;
    };
    const natural = await acuity('natural');
    const detail = await acuity('detail');
    // Detail mode should not be softer than natural mode.
    expect(detail).toBeGreaterThanOrEqual(natural - 1e-6);
  });

  it('denoises according to the shared statistic, not a per-call measurement', async () => {
    const noisy = noisyGradient(64, 64, 0.12);
    const stats = statsFor(noisy);
    expect(stats.noiseSigma).toBeGreaterThan(0);

    const withStats = await engine.upscaleSurface(
      noisy,
      2,
      getPreset('balanced'),
      makeContext({ imageStats: stats }),
    );
    // Deliberately claiming the image is clean must change the outcome, which
    // proves the statistic is actually being consumed.
    const claimedClean = await engine.upscaleSurface(
      noisy,
      2,
      getPreset('balanced'),
      makeContext({ imageStats: { noiseSigma: 0 } }),
    );
    expect(maxAbsDiff(withStats, claimedClean)).toBeGreaterThan(0.005);
  });

  it('produces a different, still-valid result in linear light', async () => {
    // Both working spaces have to be correct; they simply differ. The sRGB
    // default is the one that scores better on the benchmark suite, but linear
    // light must stay usable rather than merely present.
    const src = textLike(48, 48);
    const srgb = await engine.upscaleSurface(src, 2, getPreset('balanced'), makeContext());
    const linear = await engine.upscaleSurface(
      src,
      2,
      { ...getPreset('balanced'), workingSpace: 'linear' },
      makeContext(),
    );

    expect(linear.colorSpace).toBe('srgb');
    expect(linear.premultiplied).toBe(false);
    const { min, max } = channelRange(linear);
    expect(min).toBeGreaterThanOrEqual(0);
    expect(max).toBeLessThanOrEqual(1);
    // Linear light genuinely changes the answer, so the option is not inert.
    expect(maxAbsDiff(linear, srgb)).toBeGreaterThan(0.01);
  });

  it('reports progress that rises monotonically and finishes at the stage end', async () => {
    const seen: number[] = [];
    const reporter = new ProgressReporter((p) => seen.push(p.progress), 0);
    reporter.beginStage('upscaling', 0, 1);
    await engine.upscaleSurface(gradient(48, 48), 4, getPreset('balanced'), makeContext({ reporter }));

    expect(seen.length).toBeGreaterThan(3);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(seen.at(-1)).toBeCloseTo(1, 6);
  });

  it('splits 4x and 8x into repeated doublings, reporting progress across all of them', async () => {
    const seen: number[] = [];
    const reporter = new ProgressReporter((p) => seen.push(p.progress), 0);
    reporter.beginStage('upscaling', 0, 1);
    await engine.upscaleSurface(gradient(24, 24), 8, getPreset('balanced'), makeContext({ reporter }));
    // Three passes, each reporting several sub-steps.
    expect(seen.length).toBeGreaterThan(9);
  });
});

describe('cancellation', () => {
  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      engine.upscaleSurface(
        gradient(64, 64),
        4,
        getPreset('balanced'),
        makeContext({ signal: controller.signal }),
      ),
    ).rejects.toBeInstanceOf(CancellationError);
  });

  it('stops mid-run when the signal fires during processing', async () => {
    const controller = new AbortController();
    // Abort from a progress callback, which runs inside the pipeline.
    const reporter = new ProgressReporter(() => controller.abort(), 0);
    reporter.beginStage('upscaling', 0, 1);

    await expect(
      engine.upscaleSurface(
        gradient(128, 128),
        8,
        getPreset('balanced'),
        makeContext({ reporter, signal: controller.signal }),
      ),
    ).rejects.toBeInstanceOf(CancellationError);
  });

  it('reports CANCELLED as the error code', async () => {
    const controller = new AbortController();
    controller.abort();
    try {
      await engine.upscaleSurface(
        gradient(16, 16),
        2,
        getPreset('balanced'),
        makeContext({ signal: controller.signal }),
      );
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as CancellationError).code).toBe('CANCELLED');
    }
  });
});

describe('tile seams', () => {
  /**
   * The guarantee: for an engine with a hard filter support radius, tiled
   * processing with a halo of at least that radius produces the same pixels as
   * a single whole-image pass. Not "close enough to hide" - the same.
   *
   * This is the test that caught the global-statistics bug: the noise estimate
   * and the sharpener's gradient normalisation were both whole-image
   * reductions, so each tile computed a different one and the tile grid showed
   * up in the output.
   *
   * It also pinned down a border asymmetry that used to make this only
   * approximately true: a halo is clamp-extended in source space and then
   * upscaled, whereas an unpadded pass clamps in output space, so the outermost
   * pixels disagreed. The controller now runs every job through the padded tile
   * path - a small image is a one-tile plan - which removes the asymmetry
   * rather than papering over it, and lets these assertions be exact.
   */

  /**
   * Run a plan and reassemble it, exactly as the controller does.
   *
   * The reference for "a whole-image pass" is a *one-tile* plan, not a bare
   * `upscaleSurface` call, because a one-tile plan is what the controller
   * actually runs. A bare call has no halo, so its filters clamp at the image
   * border in output space while a tiled run has source-clamped data there -
   * a difference the library never exposes, and one that would make this test
   * measure an asymmetry that does not exist in the shipped path.
   */
  async function runPlan(
    source: Surface,
    scale: number,
    tileSize: number,
  ): Promise<Surface> {
    const preset = getPreset('balanced');
    const stats = statsFor(source);
    const plan = planTiles(source.width, source.height, tileSize, engine.tileOverlap);
    const output = createSurface(
      Math.round(source.width * scale),
      Math.round(source.height * scale),
      'srgb',
      false,
    );

    for (const tile of plan.tiles) {
      const padded = extractRegion(
        source,
        tile.paddedX,
        tile.paddedY,
        tile.paddedWidth,
        tile.paddedHeight,
      );
      const upscaled = await engine.upscaleSurface(
        padded,
        scale,
        preset,
        makeContext({ imageStats: stats }),
      );
      blitRegion(
        output,
        upscaled,
        Math.round(tile.x * scale),
        Math.round(tile.y * scale),
        Math.round(tile.offsetX * scale),
        Math.round(tile.offsetY * scale),
        Math.round(tile.width * scale),
        Math.round(tile.height * scale),
      );
    }
    return output;
  }

  it('is bit-identical to a one-tile pass on a detailed image at 2x', async () => {
    const source = textLike(96, 96);
    const whole = await runPlan(source, 2, Math.max(source.width, source.height));
    const tiled = await runPlan(source, 2, 32);
    // Every pixel, border included. Nine tiles or one, the answer is the same.
    expect(maxAbsDiff(tiled, whole)).toBe(0);
  });

  it('stays bit-identical at 4x, where the halo has to survive two passes', async () => {
    const source = textLike(64, 64);
    const whole = await runPlan(source, 4, Math.max(source.width, source.height));
    const tiled = await runPlan(source, 4, 32);
    expect(maxAbsDiff(tiled, whole)).toBe(0);
  });

  it('stays bit-identical on a hard edge, the worst case for a ringing kernel', async () => {
    const source = verticalEdge(80, 48, 37);
    const whole = await runPlan(source, 2, Math.max(source.width, source.height));
    const tiled = await runPlan(source, 2, 16);
    expect(maxAbsDiff(tiled, whole)).toBe(0);
  });

  it('is unaffected by the tile size chosen', async () => {
    const source = textLike(96, 64);
    const reference = await runPlan(source, 2, 96);
    for (const tileSize of [16, 24, 32, 48]) {
      const tiled = await runPlan(source, 2, tileSize);
      expect(maxAbsDiff(tiled, reference), `tileSize ${tileSize}`).toBe(0);
    }
  });

  it('shows no discontinuity along the tile boundaries themselves', async () => {
    // A direct check that does not depend on having a reference: the jump in
    // value across a tile boundary must be no larger than the jumps just
    // inside it.
    const source = gradient(96, 32);
    const tiled = await runPlan(source, 2, 32);
    const boundaryColumns = [64, 128]; // 32 and 64 in source, times 2.

    for (const x of boundaryColumns) {
      for (let y = 0; y < tiled.height; y++) {
        const at = (xx: number): number => tiled.data[(y * tiled.width + xx) * 4];
        const acrossSeam = Math.abs(at(x) - at(x - 1));
        const nearby = Math.max(
          Math.abs(at(x - 2) - at(x - 3)),
          Math.abs(at(x + 2) - at(x + 1)),
        );
        expect(acrossSeam, `seam at x=${x}, y=${y}`).toBeLessThanOrEqual(nearby + 2e-3);
      }
    }
  });
});

/** Reference downscale, used to build a ground-truth comparison. */
async function shrink(source: Surface, factor: number): Promise<Surface> {
  const { resample } = await import('../../packages/image-upscaler/src/algorithms/resample.js');
  const { toLinear, toSrgb } = await import('../../packages/image-upscaler/src/image/color.js');
  const { premultiply, unpremultiply } = await import(
    '../../packages/image-upscaler/src/image/alpha.js'
  );
  const working: Surface = { ...source, data: new Float32Array(source.data) };
  toLinear(working);
  premultiply(working);
  const out = resample(
    working,
    Math.round(source.width / factor),
    Math.round(source.height / factor),
  );
  unpremultiply(out);
  toSrgb(out);
  return out;
}

/** A bare Lanczos-3 enlargement, the baseline the pipeline has to beat. */
async function plainResize(source: Surface, factor: number): Promise<Surface> {
  const { resample } = await import('../../packages/image-upscaler/src/algorithms/resample.js');
  const { toLinear, toSrgb } = await import('../../packages/image-upscaler/src/image/color.js');
  const { premultiply, unpremultiply } = await import(
    '../../packages/image-upscaler/src/image/alpha.js'
  );
  const { clampSurface } = await import('../../packages/image-upscaler/src/image/color.js');
  const working: Surface = { ...source, data: new Float32Array(source.data) };
  toLinear(working);
  premultiply(working);
  const out = resample(
    working,
    Math.round(source.width * factor),
    Math.round(source.height * factor),
  );
  clampSurface(out);
  unpremultiply(out);
  toSrgb(out);
  clampSurface(out);
  return out;
}
