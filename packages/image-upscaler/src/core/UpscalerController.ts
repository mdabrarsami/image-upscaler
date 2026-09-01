import { WeightTableCache } from '../algorithms/resample.js';
import { AIInferenceSession } from '../ai/AIInference.js';
import type { ModelManager } from '../ai/ModelManager.js';
import { detectCapabilities } from '../capabilities/detectCapabilities.js';
import { AIUpscaler } from '../engines/AIUpscaler.js';
import { ClassicalUpscaler } from '../engines/ClassicalUpscaler.js';
import { HybridUpscaler } from '../engines/HybridUpscaler.js';
import type { EngineContext, ImageStatistics, UpscaleEngine } from '../engines/types.js';
import { GPUResampler } from '../gpu/GPUResampler.js';
import { nowMs, yieldToEventLoop } from '../env/environment.js';
import { estimateNoise } from '../algorithms/noise.js';
import { hasTransparency } from '../image/alpha.js';
import { decodeInput } from '../image/decoder.js';
import { chooseOutputFormat, encodeSurface } from '../image/encoder.js';
import {
  blitRegion,
  createSurface,
  extractRegion,
  CHANNELS,
  type Surface,
} from '../image/surface.js';
import {
  assertOutputSize,
  chooseTileSize,
  estimateProcessingMemory,
  formatBytes,
} from '../memory/MemoryManager.js';
import { blendWeight, planTiles, singleTile, type TilePlan } from '../memory/TileManager.js';
import { throwIfAborted, UpscalerError } from './errors.js';
import { DEFAULT_MODE, isSupportedScale, resolveTuning } from './presets.js';
import { ProgressReporter, STAGE_WEIGHTS, stageBase } from './progress.js';
import type {
  Capabilities,
  EngineName,
  EngineSelection,
  ImageUpscalerConfig,
  Logger,
  RuntimeName,
  ScaleFactor,
  UpscaleInput,
  UpscaleOptions,
} from './types.js';

export interface ControllerResult {
  blob: Blob;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  scale: number;
  engine: EngineName;
  runtime: RuntimeName;
  processingTime: number;
  format: 'png' | 'jpeg' | 'webp';
}

/**
 * The orchestrator.
 *
 * Owns everything that is true of a run regardless of which engine does the
 * arithmetic: decoding, engine choice, memory planning, tiling, cancellation,
 * progress, encoding. Engines see one surface at a time and know nothing about
 * any of it.
 */
export class UpscalerController {
  private readonly config: ImageUpscalerConfig;
  private readonly models: ModelManager;
  private readonly logger: Logger;
  private readonly cache = new WeightTableCache();

  private classical: ClassicalUpscaler | undefined;
  private gpuProbe: Promise<GPUResampler | null> | undefined;
  private gpuAttached = false;
  private readonly aiSessions = new Map<string, Promise<AIInferenceSession>>();

  constructor(config: ImageUpscalerConfig, models: ModelManager, logger: Logger) {
    this.config = config;
    this.models = models;
    this.logger = logger;
  }

  async upscale(input: UpscaleInput, options: UpscaleOptions = {}): Promise<ControllerResult> {
    const started = nowMs();
    const signal = options.signal;
    throwIfAborted(signal);

    const scale = this.resolveScale(options.scale);
    const mode = options.mode ?? this.config.mode ?? DEFAULT_MODE;
    const tuning = resolveTuning(mode, options);
    const reporter = new ProgressReporter(options.onProgress);

    // --- decode -----------------------------------------------------------
    reporter.beginStage('decoding', stageBase('decoding'), STAGE_WEIGHTS.decoding);
    const { surface: source, sourceFormat } = await decodeInput(input);
    throwIfAborted(signal);
    reporter.report(1);

    const outWidth = Math.round(source.width * scale);
    const outHeight = Math.round(source.height * scale);
    assertOutputSize(outWidth, outHeight);

    // --- plan -------------------------------------------------------------
    reporter.beginStage('analyzing', stageBase('analyzing'), STAGE_WEIGHTS.analyzing);
    const capabilities = await detectCapabilities();
    const engine = await this.selectEngine(
      options.engine ?? this.config.engine ?? 'auto',
      { scale, mode, model: options.model },
      source,
      capabilities,
    );
    const plan = this.planTiling(source, scale, engine, options.tileSize, capabilities);
    // Measured on the whole source, once, and shared by every tile. See
    // `ImageStatistics` for why this cannot be done per tile.
    const imageStats: ImageStatistics = {
      noiseSigma: tuning.noiseReduction > 0 ? estimateNoise(source) : 0,
    };
    this.logger.debug(
      `engine=${engine.name} runtime=${engine.runtime} scale=${scale} ` +
        `tiles=${plan.tiles.length} (${plan.tileSize}px +${plan.overlap})`,
    );
    reporter.report(1);
    throwIfAborted(signal);

    // --- upscale ----------------------------------------------------------
    reporter.beginStage('upscaling', stageBase('upscaling'), STAGE_WEIGHTS.upscaling + STAGE_WEIGHTS.reconstructing + STAGE_WEIGHTS.sharpening);
    const result = await this.runTiled(
      engine,
      source,
      scale,
      tuning,
      plan,
      reporter,
      signal,
      imageStats,
    );
    throwIfAborted(signal);

    // --- encode -----------------------------------------------------------
    reporter.beginStage('encoding', stageBase('encoding'), STAGE_WEIGHTS.encoding);
    const format = chooseOutputFormat(
      options.output?.format,
      sourceFormat,
      hasTransparency(result),
      capabilities.encodableFormats,
    );
    const blob = await encodeSurface(result, {
      format,
      quality: options.output?.quality,
    });
    reporter.finish();

    return {
      blob,
      width: result.width,
      height: result.height,
      originalWidth: source.width,
      originalHeight: source.height,
      scale,
      engine: engine.name,
      runtime: engine.runtime,
      processingTime: nowMs() - started,
      format,
    };
  }

  private resolveScale(scale: number | undefined): ScaleFactor {
    const value = scale ?? 2;
    if (!isSupportedScale(value)) {
      throw new UpscalerError(
        'INVALID_OPTIONS',
        `Unsupported scale ${String(value)}. Supported factors are 2, 3, 4 and 8.`,
        { details: { scale: value } },
      );
    }
    return value;
  }

  // --- engine selection ---------------------------------------------------

  /**
   * Pick an engine.
   *
   * `auto` prefers AI when a model is already installed and the device can run
   * it, because that is where the quality difference is largest. It never
   * downloads 67 MB on the user's behalf without being asked: an uninstalled
   * model means classical. Any failure in constructing the AI engine also
   * means classical - a slower, plainer result is always better than an error.
   */
  private async selectEngine(
    selection: EngineSelection,
    request: { scale: number; mode: string; model?: string },
    source: Surface,
    capabilities: Capabilities,
  ): Promise<UpscaleEngine> {
    if (selection === 'classical') return this.getClassical();

    if (selection === 'ai' || selection === 'hybrid') {
      // An explicit request is honoured or it fails loudly. Silently falling
      // back here would make `engine: 'ai'` a lie.
      const ai = await this.createAIEngine(request.model, request.scale);
      return selection === 'ai' ? ai : new HybridUpscaler(ai);
    }

    if (request.mode === 'pixel-art') {
      // A GAN will happily smear pixel art into mush. Never auto-select it.
      return this.getClassical();
    }

    const modelId = request.model ?? (await this.pickAutoModel(request.scale));
    if (!modelId) {
      this.logger.debug('auto: no installed AI model, using the classical engine');
      return this.getClassical();
    }

    const memory = estimateProcessingMemory(source.width, source.height, request.scale, 'ai', capabilities.estimatedMemory);
    if (!memory.fits && !capabilities.webGPU) {
      // AI on WASM at this size would take minutes and risk the tab.
      this.logger.debug(
        `auto: ${formatBytes(memory.peakBytes)} needed with no WebGPU; using the classical engine`,
      );
      return this.getClassical();
    }

    try {
      return await this.createAIEngine(modelId, request.scale);
    } catch (error) {
      this.logger.warn('auto: AI engine unavailable, falling back to classical', error);
      return this.getClassical();
    }
  }

  /** The installed model whose native scale best matches the request. */
  private async pickAutoModel(scale: number): Promise<string | undefined> {
    const configured = this.config.defaultModel;
    if (configured && (await this.models.isInstalled(configured).catch(() => false))) {
      return configured;
    }
    const installed = (await this.models.list().catch(() => [])).filter((m) => m.installed);
    if (installed.length === 0) return undefined;
    const exact = installed.find((m) => m.scale === scale);
    if (exact) return exact.id;
    const divisor = installed
      .filter((m) => scale % m.scale === 0)
      .sort((a, b) => b.scale - a.scale)[0];
    return (divisor ?? installed[0]).id;
  }

  private async createAIEngine(modelId: string | undefined, scale: number): Promise<AIUpscaler> {
    const resolvedId =
      modelId ?? this.config.defaultModel ?? this.models.registry.findForScale(scale)?.id;
    if (!resolvedId) {
      throw new UpscalerError('MODEL_NOT_FOUND', 'No AI model is registered for this scale', {
        details: { scale },
      });
    }
    const model = this.models.registry.get(resolvedId);

    if (!(await this.models.isInstalled(resolvedId).catch(() => false))) {
      throw new UpscalerError(
        'MODEL_NOT_INSTALLED',
        `Model "${resolvedId}" is not installed. Call upscaler.models.download(${JSON.stringify(resolvedId)}) first.`,
        { details: { modelId: resolvedId, size: model.size } },
      );
    }

    let sessionPromise = this.aiSessions.get(resolvedId);
    if (!sessionPromise) {
      sessionPromise = (async () => {
        const bytes = await this.models.load(resolvedId);
        return AIInferenceSession.create(model, bytes, {
          loader: this.config.onnxRuntimeLoader as (() => Promise<unknown>) | undefined,
          logger: this.logger,
        });
      })();
      // A failed session must not be cached, or every later attempt inherits
      // the failure.
      sessionPromise.catch(() => this.aiSessions.delete(resolvedId));
      this.aiSessions.set(resolvedId, sessionPromise);
    }

    return new AIUpscaler(await sessionPromise);
  }

  private getClassical(): ClassicalUpscaler {
    this.classical ??= new ClassicalUpscaler();
    return this.classical;
  }

  /**
   * Attach a GPU resampler to the classical engine, once, in the background.
   * Probing costs an adapter request, so it is not done unless the classical
   * engine is actually used.
   */
  async warmUp(): Promise<void> {
    this.gpuProbe ??= GPUResampler.create(this.logger);
    const gpu = await this.gpuProbe;
    if (!gpu) return;

    // Idempotent on purpose. A second call must not rebuild the engine: the
    // rebuild disposes the previous one, and the previous one owns the *same*
    // resampler instance, so disposing it would leave the new engine holding a
    // dead GPU resampler and silently drop every later run to the CPU.
    if (this.gpuAttached) return;
    this.gpuAttached = true;

    // Rebuilt rather than mutated, because ClassicalUpscaler takes the
    // resampler at construction so its `runtime` getter cannot go stale.
    const previous = this.classical;
    this.classical = new ClassicalUpscaler({ resampler: gpu });
    // The old engine never had the resampler, so disposing it cannot take the
    // GPU down with it.
    void previous?.dispose();
  }

  // --- tiling -------------------------------------------------------------

  private planTiling(
    source: Surface,
    scale: number,
    engine: UpscaleEngine,
    requested: number | 'auto' | undefined,
    capabilities: Capabilities,
  ): TilePlan {
    const overlap = engine.tileOverlap;

    if (typeof requested === 'number' && requested > 0) {
      if (requested >= source.width && requested >= source.height) {
        return singleTile(source.width, source.height, overlap);
      }
      return planTiles(source.width, source.height, requested, overlap);
    }

    // An engine with a native tile size (any AI model) always tiles at that
    // size: the network was exported and validated at that resolution.
    if (engine.preferredTileSize !== null) {
      const size = engine.preferredTileSize;
      if (source.width <= size && source.height <= size) {
        return singleTile(source.width, source.height, overlap);
      }
      return planTiles(source.width, source.height, size, overlap);
    }

    const memory = estimateProcessingMemory(
      source.width,
      source.height,
      scale,
      engine.name,
      capabilities.estimatedMemory,
    );
    if (memory.fits) return singleTile(source.width, source.height, overlap);

    const size = chooseTileSize(source.width, source.height, scale, engine.name, {
      budget: capabilities.estimatedMemory,
      overlap,
    });
    this.logger.debug(
      `tiling at ${size}px: a single pass would need ${formatBytes(memory.peakBytes)} ` +
        `against a ${formatBytes(memory.budget)} budget`,
    );
    return planTiles(source.width, source.height, size, overlap);
  }

  /**
   * Tiled execution.
   *
   * Each tile is extracted with its halo, processed independently, and written
   * back interior-only. Engines that can guarantee a hard support radius
   * (classical) get a straight copy; engines that cannot (AI) get a feathered
   * accumulate, which needs a weight buffer to normalise by at the end.
   *
   * This is the only execution path, including for an image small enough to
   * process in one piece - that case is simply a one-tile plan. Having a
   * separate unpadded fast path meant a single-tile run clamped its filters at
   * the output boundary while a tiled run had real (source-clamped) data there,
   * so the two disagreed along the image border by as much as 15 of 255 levels.
   * One path costs one extra region copy and makes tiled and untiled output
   * identical by construction.
   */
  private async runTiled(
    engine: UpscaleEngine,
    source: Surface,
    scale: number,
    tuning: ReturnType<typeof resolveTuning>,
    plan: TilePlan,
    reporter: ProgressReporter,
    signal: AbortSignal | undefined,
    imageStats: ImageStatistics,
  ): Promise<Surface> {
    const outWidth = Math.round(source.width * scale);
    const outHeight = Math.round(source.height * scale);
    const output = createSurface(outWidth, outHeight, 'srgb', false);
    const weights = engine.featherTiles ? new Float32Array(outWidth * outHeight) : null;

    const total = plan.tiles.length;
    for (let i = 0; i < total; i++) {
      throwIfAborted(signal);
      const tile = plan.tiles[i];

      const padded = extractRegion(
        source,
        tile.paddedX,
        tile.paddedY,
        tile.paddedWidth,
        tile.paddedHeight,
      );

      const ctx: EngineContext = {
        signal,
        reporter,
        cache: this.cache,
        logger: this.logger,
        progressBase: i / total,
        progressSpan: 1 / total,
        imageStats,
      };
      reporter.report(i / total, { currentTile: i + 1, totalTiles: total });

      const upscaled = await engine.upscaleSurface(padded, scale, tuning, ctx);

      if (weights) {
        accumulateFeathered(output, weights, upscaled, tile, plan.overlap, scale);
      } else {
        // Hard cut: skip the halo, copy the interior.
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

      // Give the event loop a turn between tiles so an abort can land and, on
      // the main thread, so the page stays responsive.
      await yieldToEventLoop();
    }

    if (weights) normaliseAccumulated(output, weights);
    reporter.report(1, { currentTile: total, totalTiles: total });
    return output;
  }

  async dispose(): Promise<void> {
    this.cache.clear();
    await this.classical?.dispose();
    this.classical = undefined;
    for (const sessionPromise of this.aiSessions.values()) {
      await sessionPromise.then((s) => s.release()).catch(() => undefined);
    }
    this.aiSessions.clear();
  }
}

/** Weighted accumulate of one padded tile into the shared output. */
function accumulateFeathered(
  output: Surface,
  weights: Float32Array,
  tileSurface: Surface,
  tile: TilePlan['tiles'][number],
  overlap: number,
  scale: number,
): void {
  const scaledOverlap = Math.max(1, Math.round(overlap * scale));
  const originX = Math.round(tile.paddedX * scale);
  const originY = Math.round(tile.paddedY * scale);

  const tw = tileSurface.width;
  const th = tileSurface.height;
  const src = tileSurface.data;
  const dst = output.data;

  for (let y = 0; y < th; y++) {
    const oy = originY + y;
    if (oy < 0 || oy >= output.height) continue;
    for (let x = 0; x < tw; x++) {
      const ox = originX + x;
      if (ox < 0 || ox >= output.width) continue;

      const w = blendWeight(x, y, tw, th, scaledOverlap, tile);
      if (w <= 0) continue;

      const si = (y * tw + x) * CHANNELS;
      const p = oy * output.width + ox;
      const di = p * CHANNELS;
      dst[di] += src[si] * w;
      dst[di + 1] += src[si + 1] * w;
      dst[di + 2] += src[si + 2] * w;
      dst[di + 3] += src[si + 3] * w;
      weights[p] += w;
    }
  }
}

function normaliseAccumulated(output: Surface, weights: Float32Array): void {
  const data = output.data;
  for (let p = 0, i = 0; p < weights.length; p++, i += CHANNELS) {
    const w = weights[p];
    if (w > 1e-6) {
      const inv = 1 / w;
      data[i] *= inv;
      data[i + 1] *= inv;
      data[i + 2] *= inv;
      data[i + 3] *= inv;
    }
  }
}
