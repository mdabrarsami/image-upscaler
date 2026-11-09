/**
 * Public type surface for @mdabrarsami/image-upscaler.
 *
 * Everything exported from here is part of the stable API. Internal helper
 * types live next to their implementation instead.
 */

/** Anything the SDK knows how to turn into pixels. */
export type UpscaleInput =
  | Blob
  | File
  | ArrayBuffer
  | ArrayBufferView
  | ImageData
  | ImageBitmap
  | HTMLImageElement
  | HTMLCanvasElement
  | OffscreenCanvas;

export type ScaleFactor = 2 | 3 | 4 | 8;

export type EngineName = 'classical' | 'ai' | 'hybrid';
export type EngineSelection = 'auto' | EngineName;

/** Where the heavy math actually ran. */
export type RuntimeName = 'webgpu' | 'webgl' | 'wasm' | 'cpu';

/**
 * Tuning presets. These only change algorithm parameters; every mode uses the
 * same pipeline so behaviour stays predictable.
 */
export type UpscaleMode =
  | 'natural'
  | 'balanced'
  | 'detail'
  | 'document'
  | 'pixel-art';

export type OutputFormat = 'png' | 'jpeg' | 'webp';

export interface OutputOptions {
  /** Defaults to the input format when it is encodable, otherwise `png`. */
  format?: OutputFormat;
  /** 0..1. Ignored for `png`. Defaults to 0.92. */
  quality?: number;
}

export type ProgressStage =
  | 'decoding'
  | 'analyzing'
  | 'upscaling'
  | 'reconstructing'
  | 'sharpening'
  | 'encoding'
  | 'complete';

export interface UpscaleProgress {
  /** 0..1, monotonically non-decreasing across a single upscale() call. */
  progress: number;
  stage: ProgressStage;
  /** 1-based, only present while tiles are being processed. */
  currentTile?: number;
  totalTiles?: number;
}

export interface UpscaleOptions {
  scale?: ScaleFactor;
  engine?: EngineSelection;
  mode?: UpscaleMode;
  /** Model id from the registry. Only meaningful for `ai` / `hybrid`. */
  model?: string;
  output?: OutputOptions;
  /** Tile edge length in source pixels, or `'auto'` (the default). */
  tileSize?: number | 'auto';

  /**
   * Colour space the filters work in.
   *
   * `srgb` (the default) filters the encoded values directly. `linear`
   * converts to linear light first, which is the physically correct way to
   * average light and avoids the classic darkening of bright thin features
   * against dark backgrounds.
   *
   * The default is `srgb` because it measures better: on the benchmark suite
   * linear-light Lanczos-3 scores 1 to 2 dB PSNR and 0.03 to 0.05 SSIM *worse*
   * than the same kernel in sRGB, consistently across sizes and factors. Almost
   * everything on the web was authored, composited and antialiased in sRGB, so
   * reconstructing it in sRGB is closer to the truth. Choose `linear` for
   * content that genuinely represents light - HDR-derived images, renders, or
   * anything where a bright line on a dark ground must not lose energy.
   *
   * Alpha handling is unaffected: premultiplication is applied in both cases,
   * because that is about compositing rather than about gamma.
   */
  workingSpace?: 'srgb' | 'linear';

  /** All 0..1. Undefined means "use the value from `mode`". */
  sharpening?: number;
  detail?: number;
  noiseReduction?: number;
  edgeProtection?: number;
  antiRinging?: number;

  signal?: AbortSignal;
  onProgress?: (progress: UpscaleProgress) => void;
}

export interface UpscaleResult {
  readonly blob: Blob;
  readonly width: number;
  readonly height: number;
  readonly originalWidth: number;
  readonly originalHeight: number;
  readonly scale: number;
  readonly engine: EngineName;
  readonly runtime: RuntimeName;
  /** Wall-clock milliseconds for the whole call, decode and encode included. */
  readonly processingTime: number;
  readonly format: OutputFormat;

  arrayBuffer(): Promise<ArrayBuffer>;
  toObjectURL(): string;
  /** Browser-only convenience. Throws outside a DOM context. */
  download(filename?: string): void;
}

export interface Capabilities {
  webGPU: boolean;
  webGL: boolean;
  webGL2: boolean;
  offscreenCanvas: boolean;
  workers: boolean;
  wasm: boolean;
  wasmSimd: boolean;
  sharedArrayBuffer: boolean;
  createImageBitmap: boolean;
  indexedDB: boolean;
  /** Largest square texture the GPU reports, or null when no GPU path exists. */
  maxTextureSize: number | null;
  /** Largest single GPU buffer, in bytes. WebGPU only. */
  maxBufferSize: number | null;
  /**
   * Rough working-memory budget in bytes. Derived from
   * `navigator.deviceMemory` when available, otherwise a conservative guess.
   * Treat it as an order of magnitude, not a measurement.
   */
  estimatedMemory: number;
  /** True when `estimatedMemory` came from a real browser signal. */
  estimatedMemoryIsReported: boolean;
  encodableFormats: OutputFormat[];
  hardwareConcurrency: number;
}

export interface ModelInfo {
  id: string;
  name: string;
  /** Native scale the network was trained for. */
  scale: number;
  /** Download size in bytes. */
  size: number;
  version: string;
  license: string;
  source: string;
  attribution?: string;
  installed: boolean;
  /** Tile edge length, in source pixels, the model prefers. */
  preferredTileSize: number;
  /** Overlap between tiles, in source pixels. */
  tileOverlap: number;
  /** Number of colour channels the network consumes. Alpha is handled apart. */
  channels: 3 | 4;
}

export interface ModelDefinition {
  id: string;
  name: string;
  scale: number;
  size: number;
  version: string;
  license: string;
  source: string;
  attribution?: string;
  url: string;
  /** Lowercase hex SHA-256 of the model file. Optional but strongly advised. */
  sha256?: string;
  preferredTileSize?: number;
  tileOverlap?: number;
  channels?: 3 | 4;
  /** Input pixel range the network expects. Defaults to `[0, 1]`. */
  inputRange?: [number, number];
  /** Tensor layout. Only NCHW is supported today. */
  layout?: 'nchw';
}

export interface DownloadProgress {
  /** 0..1, or null when the server sent no content-length. */
  progress: number | null;
  loaded: number;
  total: number | null;
  modelId: string;
}

export interface DownloadOptions {
  signal?: AbortSignal;
  onProgress?: (progress: DownloadProgress) => void;
  /** Re-download even when a cached copy exists. */
  force?: boolean;
  /** Retry attempts on network failure. Defaults to 2. */
  retries?: number;
}

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface ImageUpscalerConfig {
  engine?: EngineSelection;
  mode?: UpscaleMode;
  /** Defaults to true when Workers are available. */
  useWorker?: boolean;
  /** Replace the built-in model catalogue. */
  models?: ModelDefinition[];
  /** Default model id for the AI engine. */
  defaultModel?: string;
  /**
   * Loader for the ONNX Runtime Web module. Supply this when your bundler
   * cannot resolve a bare dynamic import, or to pin a specific build.
   */
  onnxRuntimeLoader?: () => Promise<unknown>;
  /** Override the URL the worker is constructed from. */
  workerUrl?: string | URL;
  /** Emit diagnostics through this sink instead of the console. */
  logger?: Logger;
}
