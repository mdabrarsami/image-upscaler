/**
 * @mdabrarsami/image-upscaler
 *
 * Client-side image upscaling. Classical (Lanczos, edge-directed refinement,
 * detail reconstruction) always available; optional local AI super-resolution
 * loaded on demand. No backend, no API key, no upload.
 *
 * This file is the entire public API. Anything not re-exported here is an
 * implementation detail and may change in a patch release.
 */

export { ImageUpscaler } from './core/ImageUpscaler.js';
export { UpscalerError, CancellationError, isCancellation } from './core/errors.js';
export type { UpscalerErrorCode } from './core/errors.js';

export { detectCapabilities, detectCapabilitiesSync } from './capabilities/detectCapabilities.js';

export { ClassicalUpscaler } from './engines/ClassicalUpscaler.js';
export type { Resampler, ClassicalUpscalerOptions } from './engines/ClassicalUpscaler.js';
export { AIUpscaler } from './engines/AIUpscaler.js';
export { HybridUpscaler } from './engines/HybridUpscaler.js';
export type { UpscaleEngine, EngineContext, ImageStatistics } from './engines/types.js';

// The GPU resample is the one accelerated stage, and it implements the same
// `Resampler` interface a consumer can supply, so it is public: swapping it out
// or driving it directly are both legitimate.
export { GPUResampler } from './gpu/GPUResampler.js';
export { WebGPUContext } from './gpu/WebGPUContext.js';

export { ModelManager } from './ai/ModelManager.js';
export { ModelRegistry, BUILTIN_MODELS } from './ai/ModelRegistry.js';
export type { ResolvedModel } from './ai/ModelRegistry.js';
export { ModelCache } from './ai/ModelCache.js';

export { getPreset, listModes, resolveTuning, SUPPORTED_SCALES } from './core/presets.js';
export type { ResolvedTuning } from './core/presets.js';

export { UpscaleResultImpl } from './core/UpscaleResult.js';
export { UpscalerController } from './core/UpscalerController.js';

// --- lower-level building blocks -----------------------------------------
// Exported because they are genuinely useful on their own (a thumbnailer only
// needs `resample`), and because they are what makes the ESM build worth
// tree-shaking.

export {
  resample,
  resampleByScale,
  nearestScale,
  WeightTableCache,
} from './algorithms/resample.js';
export {
  buildWeightTable,
  getKernel,
  lanczos,
  lanczos2,
  lanczos3,
  lanczos4,
  bicubic,
  bilinear,
  mitchell,
  box,
  cubicBC,
} from './algorithms/kernels.js';
export type { FilterKernel, KernelName, WeightTable } from './algorithms/kernels.js';
export { blurPlane, blurSurface, gaussianKernel1D } from './algorithms/gaussian.js';
export {
  gradient,
  gradientMagnitude,
  gradientOrientation,
  structureTensor,
  analyzeTensor,
} from './algorithms/edges.js';
export { edgeDirectedRefine } from './algorithms/edge-directed.js';
export { adaptiveSharpen, suppressHalos, localContrast } from './algorithms/sharpening.js';
export { extractDetail, reconstructDetail, transferDetail } from './algorithms/detail.js';
export { bilateralDenoise, estimateNoise } from './algorithms/noise.js';
export { antiRing, antiRingLocal } from './algorithms/anti-ringing.js';

export {
  createSurface,
  cloneSurface,
  surfaceFromImageData,
  surfaceToUint8,
  surfaceBytes,
  extractRegion,
  blitRegion,
} from './image/surface.js';
export type { Surface, SurfaceColorSpace } from './image/surface.js';
export { toLinear, toSrgb, srgbToLinear, linearToSrgb, lumaPlane } from './image/color.js';
export { premultiply, unpremultiply, hasTransparency, bleedEdges } from './image/alpha.js';
export { decodeInput, sniffFormat } from './image/decoder.js';
export { encodeSurface, chooseOutputFormat, surfaceToImageData } from './image/encoder.js';

export {
  estimateMemoryBudget,
  estimateProcessingMemory,
  chooseTileSize,
  formatBytes,
  MAX_OUTPUT_PIXELS,
} from './memory/MemoryManager.js';
export { planTiles, singleTile, blendWeight } from './memory/TileManager.js';
export type { Tile, TilePlan } from './memory/TileManager.js';

export { detectEnvironment } from './env/environment.js';

// --- types ----------------------------------------------------------------

export type {
  Capabilities,
  DownloadOptions,
  DownloadProgress,
  EngineName,
  EngineSelection,
  ImageUpscalerConfig,
  Logger,
  ModelDefinition,
  ModelInfo,
  OutputFormat,
  OutputOptions,
  ProgressStage,
  RuntimeName,
  ScaleFactor,
  UpscaleInput,
  UpscaleMode,
  UpscaleOptions,
  UpscaleProgress,
  UpscaleResult,
} from './core/types.js';

/** Package version. Replaced at build time. */
export const VERSION = '0.1.0';
