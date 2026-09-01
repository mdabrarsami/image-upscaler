import { CancellationError, UpscalerError } from '../core/errors.js';
import type { Logger, UpscaleInput, UpscaleOptions } from '../core/types.js';
import { supportsWorkers } from '../env/environment.js';
import { decodeInput } from '../image/decoder.js';
import { surfaceToUint8 } from '../image/surface.js';
import type { ControllerResult } from '../core/UpscalerController.js';
import {
  toSerializableOptions,
  type WorkerConfig,
  type WorkerImagePayload,
  type WorkerRequest,
  type WorkerResponse,
} from './protocol.js';

/**
 * Main-thread half of the Worker bridge.
 *
 * Consumers never see any of this: they set `useWorker: true` and the same
 * `upscale()` call runs off-thread. If a Worker cannot be created - no
 * `import.meta.url` in a classic script, a CSP that blocks blob workers, a
 * bundler that did not emit the chunk - the caller is told and falls back to
 * the main thread rather than failing.
 */
export interface WorkerBridgeOptions {
  workerUrl?: string | URL;
  logger: Logger;
  config: WorkerConfig;
}

interface PendingJob {
  resolve: (result: ControllerResult) => void;
  reject: (error: unknown) => void;
  onProgress?: UpscaleOptions['onProgress'];
}

export class WorkerBridge {
  private readonly options: WorkerBridgeOptions;
  private worker: Worker | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, PendingJob>();
  private failed = false;

  constructor(options: WorkerBridgeOptions) {
    this.options = options;
  }

  /** True when a Worker could be created. Checked before every job. */
  get usable(): boolean {
    return !this.failed && supportsWorkers();
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;

    const url = this.resolveWorkerUrl();
    let worker: Worker;
    try {
      worker = new Worker(url, { type: 'module', name: 'image-upscaler' });
    } catch (cause) {
      this.failed = true;
      throw new UpscalerError('WORKER_FAILED', `Could not start the upscaler Worker at ${String(url)}`, {
        cause,
      });
    }

    worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
      this.handleMessage(event.data);
    });
    worker.addEventListener('error', (event) => {
      // A hard worker error kills every job it was carrying; there is no way
      // to know which one threw.
      this.failed = true;
      const error = new UpscalerError('WORKER_FAILED', event.message || 'The upscaler Worker crashed');
      for (const [id, job] of this.pending) {
        job.reject(error);
        this.pending.delete(id);
      }
      this.terminate();
    });

    this.worker = worker;
    return worker;
  }

  private resolveWorkerUrl(): string | URL {
    if (this.options.workerUrl) return this.options.workerUrl;
    try {
      // Bundlers recognise this exact shape and emit the worker as a chunk.
      return new URL('./worker.js', import.meta.url);
    } catch (cause) {
      this.failed = true;
      throw new UpscalerError(
        'WORKER_FAILED',
        'Cannot locate the worker bundle. Pass `workerUrl` when loading from a classic <script> tag.',
        { cause },
      );
    }
  }

  private handleMessage(message: WorkerResponse): void {
    if (message.id === -1) return; // Ready ping.
    const job = this.pending.get(message.id);
    if (!job) return;

    switch (message.type) {
      case 'progress':
        job.onProgress?.(message.progress);
        break;
      case 'result':
        this.pending.delete(message.id);
        job.resolve({
          blob: message.blob,
          width: message.width,
          height: message.height,
          originalWidth: message.originalWidth,
          originalHeight: message.originalHeight,
          scale: message.scale,
          engine: message.engine,
          runtime: message.runtime,
          processingTime: message.processingTime,
          format: message.format,
        });
        break;
      case 'error':
        this.pending.delete(message.id);
        job.reject(UpscalerError.fromSerialized(message.error));
        break;
      case 'pong':
        break;
    }
  }

  async upscale(input: UpscaleInput, options: UpscaleOptions): Promise<ControllerResult> {
    const worker = this.ensureWorker();
    const id = this.nextId++;

    const { payload, transfer } = await prepareInput(input);

    const request: WorkerRequest = {
      type: 'upscale',
      id,
      image: payload,
      options: toSerializableOptions(options),
      config: this.options.config,
    };

    const promise = new Promise<ControllerResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress: options.onProgress });
    });

    const signal = options.signal;
    const onAbort = (): void => {
      worker.postMessage({ type: 'abort', id } satisfies WorkerRequest);
      const job = this.pending.get(id);
      if (job) {
        this.pending.delete(id);
        job.reject(new CancellationError());
      }
    };
    if (signal) {
      if (signal.aborted) {
        this.pending.delete(id);
        throw new CancellationError();
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      worker.postMessage(request, transfer);
      return await promise;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  terminate(): void {
    this.worker?.terminate();
    this.worker = undefined;
    this.pending.clear();
  }
}

/**
 * Get the input into something structured-cloneable.
 *
 * Blobs, ArrayBuffers and ImageBitmaps go straight across. DOM elements cannot
 * cross a thread boundary at all, so those are decoded here first and sent as
 * raw pixels - which costs one main-thread decode but keeps the expensive part
 * off-thread, which is the point.
 */
async function prepareInput(
  input: UpscaleInput,
): Promise<{ payload: WorkerImagePayload; transfer: Transferable[] }> {
  const wrap = (
    payload: WorkerImagePayload,
    transfer: Transferable[] = [],
  ): { payload: WorkerImagePayload; transfer: Transferable[] } => ({ payload, transfer });

  // Buffers the caller still owns are copied before being transferred.
  // Transferring the original would detach it, leaving the consumer holding a
  // zero-length array they never asked us to consume.
  if (typeof Blob !== 'undefined' && input instanceof Blob) return wrap(input);
  if (input instanceof ArrayBuffer) {
    const copy = input.slice(0);
    return wrap(copy, [copy]);
  }
  if (ArrayBuffer.isView(input)) {
    const copy = copyOf(input);
    return wrap(copy, [copy]);
  }
  if (typeof ImageBitmap !== 'undefined' && input instanceof ImageBitmap) {
    // An ImageBitmap is a handle, not a buffer; the caller is expected to have
    // handed over ownership, which is the documented contract for transfer.
    return wrap(input, [input]);
  }
  if (typeof ImageData !== 'undefined' && input instanceof ImageData) {
    const buffer = copyOf(input.data);
    return wrap(
      { kind: 'raw', data: buffer, width: input.width, height: input.height, sourceFormat: null },
      [buffer],
    );
  }

  // Canvas or <img>: decode on this thread, ship the pixels.
  const decoded = await decodeInput(input);
  const bytes = surfaceToUint8(decoded.surface);
  const buffer = copyOf(bytes);
  return wrap(
    {
      kind: 'raw',
      data: buffer,
      width: decoded.surface.width,
      height: decoded.surface.height,
      sourceFormat: decoded.sourceFormat,
    },
    [buffer],
  );
}

/** A fresh ArrayBuffer holding a view's bytes, safe to transfer. */
function copyOf(view: ArrayBufferView): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}
