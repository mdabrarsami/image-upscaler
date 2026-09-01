/**
 * Worker entry point.
 *
 * Built as its own bundle so it can be handed to `new Worker(url, { type:
 * 'module' })`. It reuses the same controller the main thread does - there is
 * no duplicated image code here, only message plumbing.
 */
import { UpscalerError } from '../core/errors.js';
import { silentLogger } from '../core/logger.js';
import { UpscalerController } from '../core/UpscalerController.js';
import type { UpscaleInput, UpscaleOptions } from '../core/types.js';
import { ModelManager } from '../ai/ModelManager.js';
import { ModelRegistry } from '../ai/ModelRegistry.js';
import type {
  TransferredImage,
  WorkerConfig,
  WorkerRequest,
  WorkerResponse,
} from './protocol.js';

const scope = self as unknown as DedicatedWorkerGlobalScope;

/** One abort controller per in-flight job, so `abort` can target a single id. */
const running = new Map<number, AbortController>();

/**
 * Controllers are reused across jobs, keyed by the config that produced them.
 *
 * Building one per message threw away everything a controller exists to hold -
 * the GPU device, compiled shaders, filter weight tables and inference sessions
 * - between every image. It also meant the worker never warmed up, so the GPU
 * resampler was attached only on the main thread while the *default* path (this
 * one) silently stayed on the CPU: a `runtime` of `cpu` on a machine with a
 * perfectly good adapter.
 */
const controllers = new Map<string, { controller: UpscalerController; models: ModelManager }>();

function controllerFor(config: WorkerConfig): {
  controller: UpscalerController;
  models: ModelManager;
} {
  const key = JSON.stringify(config ?? {});
  let entry = controllers.get(key);
  if (!entry) {
    const registry = config.models ? new ModelRegistry(config.models) : new ModelRegistry();
    const models = new ModelManager(registry);
    const controller = new UpscalerController(
      {
        engine: config.engine,
        mode: config.mode,
        defaultModel: config.defaultModel,
      },
      models,
      silentLogger,
    );
    entry = { controller, models };
    controllers.set(key, entry);
  }
  return entry;
}

function post(message: WorkerResponse): void {
  scope.postMessage(message);
}

function rebuildInput(image: unknown): UpscaleInput {
  if (isTransferredImage(image)) {
    // `ImageData` exists in workers, and the decoder accepts it directly.
    return new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
  }
  return image as UpscaleInput;
}

function isTransferredImage(value: unknown): value is TransferredImage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'raw'
  );
}

scope.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;

  if (message.type === 'ping') {
    post({ type: 'pong', id: message.id });
    return;
  }

  if (message.type === 'abort') {
    running.get(message.id)?.abort();
    return;
  }

  if (message.type !== 'upscale') return;

  const { id, options, config } = message;
  const controller = new AbortController();
  running.set(id, controller);

  const { controller: upscaler } = controllerFor(config);

  const runOptions: UpscaleOptions = {
    ...options,
    signal: controller.signal,
    onProgress: (progress) => post({ type: 'progress', id, progress }),
  };

  void (async () => {
    try {
      // Attach the GPU resampler if this device has one. Cheap after the first
      // call, and without it the worker - the default execution path - would
      // never use the GPU at all.
      await upscaler.warmUp().catch(() => undefined);
      const result = await upscaler.upscale(rebuildInput(message.image), runOptions);
      post({
        type: 'result',
        id,
        blob: result.blob,
        width: result.width,
        height: result.height,
        originalWidth: result.originalWidth,
        originalHeight: result.originalHeight,
        scale: result.scale,
        engine: result.engine,
        runtime: result.runtime,
        processingTime: result.processingTime,
        format: result.format,
      });
    } catch (error) {
      const upscalerError =
        error instanceof UpscalerError
          ? error
          : new UpscalerError('INTERNAL', error instanceof Error ? error.message : String(error));
      post({
        type: 'error',
        id,
        error: {
          code: upscalerError.code,
          message: upscalerError.message,
          details: upscalerError.details,
        },
      });
    } finally {
      // The controller is deliberately not disposed: it is shared with later
      // jobs, and disposing it here is what would make every image pay for a
      // fresh GPU device and a cold cache.
      running.delete(id);
    }
  })();
});

// Signals to the client that the module finished evaluating. Without it there
// is a window where a posted job is dropped on the floor.
post({ type: 'pong', id: -1 });
