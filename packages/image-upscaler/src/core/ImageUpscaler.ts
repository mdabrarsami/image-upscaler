import { ModelManager } from '../ai/ModelManager.js';
import { ModelRegistry } from '../ai/ModelRegistry.js';
import { detectCapabilities } from '../capabilities/detectCapabilities.js';
import { supportsWorkers } from '../env/environment.js';
import { WorkerBridge } from '../workers/worker-client.js';
import { UpscalerError, isCancellation } from './errors.js';
import { createLogger } from './logger.js';
import { UpscaleResultImpl } from './UpscaleResult.js';
import { UpscalerController, type ControllerResult } from './UpscalerController.js';
import type {
  Capabilities,
  ImageUpscalerConfig,
  Logger,
  UpscaleInput,
  UpscaleOptions,
  UpscaleResult,
} from './types.js';

/**
 * The library's front door.
 *
 * Everything a consumer normally needs is on this class: `upscale`, `models`,
 * `capabilities`. It owns a controller (which does the work), a model manager
 * (which owns the catalogue and cache), and optionally a Worker bridge.
 *
 * One instance is meant to be long-lived. It caches the GPU device, compiled
 * shaders, weight tables and inference sessions, all of which are expensive to
 * build and cheap to keep. Constructing one per upscale works but throws that
 * away every time.
 */
export class ImageUpscaler {
  readonly models: ModelManager;

  private readonly logger: Logger;
  private readonly controller: UpscalerController;
  private bridge: WorkerBridge | undefined;
  private warmed: Promise<void> | undefined;
  private disposed = false;
  private readonly onnxLoaderConfigured: boolean;
  private readonly engineDefault: NonNullable<ImageUpscalerConfig['engine']>;

  constructor(config: ImageUpscalerConfig = {}) {
    this.logger = config.logger ?? createLogger();
    this.onnxLoaderConfigured = typeof config.onnxRuntimeLoader === 'function';
    this.engineDefault = config.engine ?? 'auto';

    const registry = config.models ? new ModelRegistry(config.models) : new ModelRegistry();
    this.models = new ModelManager(registry, undefined, this.logger);
    this.controller = new UpscalerController(config, this.models, this.logger);

    // Workers are on by default where they exist: the alternative is locking
    // the UI thread for seconds at a time on any non-trivial image.
    const wantsWorker = config.useWorker ?? true;
    if (wantsWorker && supportsWorkers()) {
      this.bridge = new WorkerBridge({
        workerUrl: config.workerUrl,
        logger: this.logger,
        config: {
          engine: config.engine,
          mode: config.mode,
          models: config.models,
          defaultModel: config.defaultModel,
        },
      });
    } else if (wantsWorker) {
      this.logger.warn(
        'Web Workers are unavailable; upscaling will run on the calling thread and may block the UI.',
      );
    }
  }

  /** Probe the device. Cached across instances. */
  async capabilities(): Promise<Capabilities> {
    return detectCapabilities();
  }

  /**
   * Warm the expensive singletons - GPU adapter, shader compilation - without
   * running a job. Worth calling on an idle callback if you know an upscale is
   * coming; entirely optional.
   */
  async warmUp(): Promise<void> {
    this.warmed ??= this.controller.warmUp().catch((error: unknown) => {
      this.logger.debug('warm-up did not complete', error);
    });
    return this.warmed;
  }

  async upscale(input: UpscaleInput, options: UpscaleOptions = {}): Promise<UpscaleResult> {
    if (this.disposed) {
      throw new UpscalerError('INTERNAL', 'This ImageUpscaler has been disposed');
    }
    if (input == null) {
      throw new UpscalerError('INVALID_INPUT', 'upscale() requires an image');
    }

    const result = await this.run(input, options);
    return new UpscaleResultImpl(result);
  }

  /**
   * A custom ONNX Runtime loader is a function, and functions do not survive
   * `postMessage`. So when one is configured and the run needs AI, the worker
   * cannot honour it and the job has to stay on this thread - silently losing
   * the loader inside the worker would surface as an unresolvable dynamic
   * import instead of an explicable fallback.
   */
  private mustAvoidWorker(options: UpscaleOptions): boolean {
    if (!this.onnxLoaderConfigured) return false;
    const engine = options.engine ?? this.engineDefault;
    return engine === 'ai' || engine === 'hybrid' || engine === 'auto';
  }

  private async run(input: UpscaleInput, options: UpscaleOptions): Promise<ControllerResult> {
    if (this.bridge?.usable && !this.mustAvoidWorker(options)) {
      try {
        return await this.bridge.upscale(input, options);
      } catch (error) {
        // A cancelled job is the caller's doing; do not silently redo it on
        // the main thread. Anything else is a worker problem, and running the
        // job here is strictly better than failing.
        if (isCancellation(error)) throw error;
        if (error instanceof UpscalerError && error.code !== 'WORKER_FAILED') throw error;
        this.logger.warn('Worker path failed; running on the calling thread instead', error);
        this.bridge = undefined;
      }
    }

    await this.warmUp();
    return this.controller.upscale(input, options);
  }

  /** Release the GPU device, inference sessions, worker and cached tables. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.bridge?.terminate();
    this.bridge = undefined;
    await this.controller.dispose();
    this.models.dispose();
  }
}
