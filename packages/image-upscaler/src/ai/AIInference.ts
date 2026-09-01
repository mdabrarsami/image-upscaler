import { detectCapabilities } from '../capabilities/detectCapabilities.js';
import { UpscalerError } from '../core/errors.js';
import type { Logger, RuntimeName } from '../core/types.js';
import { CHANNELS, createSurface, type Surface } from '../image/surface.js';
import type { ResolvedModel } from './ModelRegistry.js';

/**
 * ONNX Runtime Web bridge.
 *
 * The runtime is a large dependency (multi-megabyte WASM plus glue), so it is
 * never imported statically. It is loaded on the first AI inference and never
 * touched by consumers who only ever use the classical engine - which is the
 * whole reason the AI entry point is a separate module in the package exports.
 *
 * The runtime is typed structurally here rather than by importing its types.
 * That keeps `onnxruntime-web` a genuinely optional peer dependency: the core
 * package type-checks and builds without it installed.
 */

export interface OrtTensorLike {
  readonly data: Float32Array;
  readonly dims: readonly number[];
}

export interface OrtSessionLike {
  run(feeds: Record<string, OrtTensorLike>): Promise<Record<string, OrtTensorLike>>;
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  release?(): Promise<void>;
}

export interface OrtModuleLike {
  env: {
    wasm: { numThreads?: number; simd?: boolean; proxy?: boolean; wasmPaths?: string };
    logLevel?: string;
  };
  Tensor: new (type: 'float32', data: Float32Array, dims: readonly number[]) => OrtTensorLike;
  InferenceSession: {
    create(
      model: ArrayBuffer | Uint8Array,
      options?: Record<string, unknown>,
    ): Promise<OrtSessionLike>;
  };
}

export type OrtLoader = () => Promise<unknown>;

/**
 * The default loader.
 *
 * A bare specifier inside a dynamic import is what lets a bundler code-split
 * the runtime out of the main chunk. Bundlers that cannot resolve it (because
 * the optional peer is not installed) will warn at build time; consumers in
 * that position pass their own loader through `onnxRuntimeLoader`.
 *
 * The prebuilt browser bundles keep `onnxruntime-web` external, so a
 * script-tag or bare-ESM consumer has no resolver for it and must supply a
 * loader. A loader may also configure `ort.env` (notably `wasm.wasmPaths`)
 * before returning; whatever it sets is respected apart from thread count,
 * which is capped below to what the page can actually use.
 */
const defaultLoader: OrtLoader = () => import(/* @vite-ignore */ 'onnxruntime-web');

let cachedRuntime: Promise<OrtModuleLike> | undefined;

export async function loadOrt(loader: OrtLoader = defaultLoader, logger?: Logger): Promise<OrtModuleLike> {
  cachedRuntime ??= (async () => {
    let module: unknown;
    try {
      module = await loader();
    } catch (cause) {
      throw new UpscalerError(
        'RUNTIME_UNAVAILABLE',
        'Could not load onnxruntime-web. Install it (npm i onnxruntime-web) or supply `onnxRuntimeLoader`.',
        { cause },
      );
    }
    const ort = unwrapModule(module);
    if (!ort) {
      throw new UpscalerError(
        'RUNTIME_UNAVAILABLE',
        'The supplied ONNX Runtime module does not expose InferenceSession and Tensor',
      );
    }
    // Threads need cross-origin isolation; without the COOP/COEP headers the
    // runtime silently falls back, so cap it at what the page can actually use.
    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
    const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
    ort.env.wasm.numThreads = isolated ? Math.min(4, Math.max(1, cores - 1)) : 1;
    if (!isolated) {
      logger?.debug(
        'ONNX Runtime is single-threaded: the page is not cross-origin isolated (no COOP/COEP headers)',
      );
    }
    return ort;
  })();
  return cachedRuntime;
}

/** Test seam: forget the memoised runtime. */
export function resetOrtCache(): void {
  cachedRuntime = undefined;
}

function unwrapModule(module: unknown): OrtModuleLike | null {
  const candidates = [module, (module as { default?: unknown })?.default];
  for (const candidate of candidates) {
    if (
      candidate &&
      typeof candidate === 'object' &&
      'InferenceSession' in candidate &&
      'Tensor' in candidate
    ) {
      return candidate as OrtModuleLike;
    }
  }
  return null;
}

export interface InferenceSessionOptions {
  loader?: OrtLoader;
  logger?: Logger;
  /** Try WebGPU first. Falls back to WASM automatically. */
  preferWebGPU?: boolean;
}

/**
 * A loaded model, ready to run on tiles.
 *
 * One session per model per page. Creating a session parses and optimises the
 * graph, which for a 67 MB RRDBNet takes long enough that doing it per tile
 * would dominate the run time.
 */
export class AIInferenceSession {
  readonly model: ResolvedModel;
  readonly runtime: RuntimeName;
  private readonly session: OrtSessionLike;
  private readonly ort: OrtModuleLike;
  private readonly inputName: string;
  private readonly outputName: string;
  private released = false;

  private constructor(
    model: ResolvedModel,
    session: OrtSessionLike,
    ort: OrtModuleLike,
    runtime: RuntimeName,
  ) {
    this.model = model;
    this.session = session;
    this.ort = ort;
    this.runtime = runtime;
    this.inputName = session.inputNames[0] ?? 'input';
    this.outputName = session.outputNames[0] ?? 'output';
  }

  static async create(
    model: ResolvedModel,
    bytes: ArrayBuffer,
    options: InferenceSessionOptions = {},
  ): Promise<AIInferenceSession> {
    const ort = await loadOrt(options.loader, options.logger);

    // Whether WebGPU is genuinely usable, from a real adapter request rather
    // than from `'gpu' in navigator` - the property exists in browsers where
    // no adapter can actually be obtained.
    const gpuUsable = (options.preferWebGPU ?? true) && (await detectCapabilities()).webGPU;

    // One provider per attempt, never `['webgpu', 'wasm']` as a single list.
    //
    // Given a list, ONNX Runtime falls back internally and reports success, so
    // a session that actually ran on WASM would be labelled `webgpu`. That was
    // a real bug: the benchmark reported `runtime: 'webgpu'` on a machine whose
    // capability probe said WebGPU was unavailable. `runtime` is a public field
    // that consumers use to decide what to offer, so it has to say what really
    // happened - which means each provider has to be able to fail on its own.
    const attempts: Array<{ providers: string[]; runtime: RuntimeName }> = gpuUsable
      ? [
          { providers: ['webgpu'], runtime: 'webgpu' },
          { providers: ['wasm'], runtime: 'wasm' },
        ]
      : [{ providers: ['wasm'], runtime: 'wasm' }];

    let lastError: unknown;
    for (const attempt of attempts) {
      try {
        const session = await ort.InferenceSession.create(bytes, {
          executionProviders: attempt.providers,
          graphOptimizationLevel: 'all',
          // Sequential keeps peak memory down, which matters far more than
          // intra-op parallelism when the tile is the unit of work.
          executionMode: 'sequential',
        });
        options.logger?.debug(`AI session for "${model.id}" created on ${attempt.runtime}`);
        return new AIInferenceSession(model, session, ort, attempt.runtime);
      } catch (error) {
        lastError = error;
        options.logger?.warn(
          `AI session on ${attempt.runtime} failed; trying the next provider`,
          error,
        );
      }
    }

    throw new UpscalerError(
      'INFERENCE_FAILED',
      `Could not create an inference session for "${model.id}"`,
      { cause: lastError, details: { modelId: model.id } },
    );
  }

  /**
   * Run one tile.
   *
   * The surface must be sRGB with straight alpha. Alpha is not fed to the
   * network - Real-ESRGAN and its relatives are RGB-only, and feeding a fourth
   * channel to a three-channel graph is a shape error rather than a
   * degradation. The caller is responsible for carrying alpha across
   * separately; see `AIUpscaler`.
   */
  async run(tile: Surface): Promise<Surface> {
    if (this.released) {
      throw new UpscalerError('INFERENCE_FAILED', 'This inference session has been released');
    }
    const { width, height } = tile;
    const input = surfaceToNCHW(tile, this.model.channels, this.model.inputRange);

    let outputs: Record<string, OrtTensorLike>;
    try {
      const tensor = new this.ort.Tensor('float32', input, [
        1,
        this.model.channels,
        height,
        width,
      ]);
      outputs = await this.session.run({ [this.inputName]: tensor });
    } catch (error) {
      throw new UpscalerError('INFERENCE_FAILED', `Inference failed on a ${width}x${height} tile`, {
        cause: error,
        details: { width, height, modelId: this.model.id },
      });
    }

    const output = outputs[this.outputName] ?? Object.values(outputs)[0];
    if (!output) {
      throw new UpscalerError('INFERENCE_FAILED', 'The model produced no output tensor');
    }
    return nchwToSurface(output, this.model.inputRange);
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await this.session.release?.().catch(() => undefined);
  }
}

/**
 * Interleaved RGBA -> planar NCHW float.
 *
 * Alpha is dropped for 3-channel models. For 4-channel models it is passed
 * through as-is.
 */
export function surfaceToNCHW(
  surface: Surface,
  channels: 3 | 4,
  range: [number, number] = [0, 1],
): Float32Array {
  const { width, height, data } = surface;
  const plane = width * height;
  const out = new Float32Array(plane * channels);
  const [lo, hi] = range;
  const span = hi - lo;

  for (let p = 0, i = 0; p < plane; p++, i += CHANNELS) {
    out[p] = data[i] * span + lo;
    out[plane + p] = data[i + 1] * span + lo;
    out[plane * 2 + p] = data[i + 2] * span + lo;
    if (channels === 4) out[plane * 3 + p] = data[i + 3] * span + lo;
  }
  return out;
}

/** Planar NCHW float -> interleaved RGBA. Alpha is filled opaque when absent. */
export function nchwToSurface(tensor: OrtTensorLike, range: [number, number] = [0, 1]): Surface {
  const dims = tensor.dims;
  if (dims.length !== 4) {
    throw new UpscalerError(
      'INFERENCE_FAILED',
      `Expected a 4-D NCHW output tensor, got ${dims.length} dimensions`,
    );
  }
  const [, channels, height, width] = dims as [number, number, number, number];
  if (channels !== 3 && channels !== 4) {
    throw new UpscalerError('INFERENCE_FAILED', `Unsupported output channel count: ${channels}`);
  }

  const surface = createSurface(width, height, 'srgb', false);
  const out = surface.data;
  const src = tensor.data;
  const plane = width * height;
  const [lo, hi] = range;
  const invSpan = 1 / (hi - lo);

  for (let p = 0, i = 0; p < plane; p++, i += CHANNELS) {
    out[i] = clamp01((src[p] - lo) * invSpan);
    out[i + 1] = clamp01((src[plane + p] - lo) * invSpan);
    out[i + 2] = clamp01((src[plane * 2 + p] - lo) * invSpan);
    out[i + 3] = channels === 4 ? clamp01((src[plane * 3 + p] - lo) * invSpan) : 1;
  }
  return surface;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
