import type { WeightTableCache } from '../algorithms/resample.js';
import type { ProgressReporter } from '../core/progress.js';
import type { ResolvedTuning } from '../core/presets.js';
import type { EngineName, Logger, RuntimeName } from '../core/types.js';
import type { Surface } from '../image/surface.js';

/**
 * Statistics measured once over the whole source image.
 *
 * Anything an engine would otherwise derive from a global reduction has to
 * arrive here instead. A tile cannot compute a global statistic - it would get
 * a different answer from the whole frame, and neighbouring tiles would get
 * different answers from each other, which shows up as banding along the tile
 * grid. Measuring once and sharing is what keeps tiled output equal to
 * whole-image output.
 */
export interface ImageStatistics {
  /** Estimated noise sigma of the source, from `estimateNoise`. */
  noiseSigma: number;
}

export interface EngineContext {
  signal?: AbortSignal;
  reporter: ProgressReporter;
  /** Shared across tiles so weight tables are built once per geometry. */
  cache: WeightTableCache;
  logger: Logger;
  /** 0..1 sub-range of the `upscaling` stage this call should report into. */
  progressBase: number;
  progressSpan: number;
  /**
   * Whole-image statistics. Absent when an engine is driven directly rather
   * than through the controller, in which case it measures for itself.
   */
  imageStats?: ImageStatistics;
}

/**
 * Contract every engine implements.
 *
 * Input and output are both sRGB with straight alpha. Engines convert to
 * whatever internal representation they need and convert back, so they compose
 * freely and a caller never has to track colour state.
 */
export interface UpscaleEngine {
  readonly name: EngineName;
  /** Where this engine actually ran. Only known after `prepare`. */
  readonly runtime: RuntimeName;
  /** Preferred source-tile edge, or null to let the memory planner decide. */
  readonly preferredTileSize: number | null;
  /** Halo width, in source pixels, this engine needs around each tile. */
  readonly tileOverlap: number;
  /** True when tile write-back should be feathered rather than hard-cut. */
  readonly featherTiles: boolean;

  upscaleSurface(
    src: Surface,
    scale: number,
    tuning: ResolvedTuning,
    ctx: EngineContext,
  ): Promise<Surface>;

  dispose?(): void | Promise<void>;
}
