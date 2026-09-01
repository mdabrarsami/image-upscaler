/** Stable, machine-readable failure codes. */
export type UpscalerErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_OPTIONS'
  | 'UNSUPPORTED_FORMAT'
  | 'IMAGE_TOO_LARGE'
  | 'OUT_OF_MEMORY'
  | 'GPU_UNAVAILABLE'
  | 'GPU_LOST'
  | 'MODEL_NOT_FOUND'
  | 'MODEL_DOWNLOAD_FAILED'
  | 'MODEL_CORRUPTED'
  | 'MODEL_NOT_INSTALLED'
  | 'STORAGE_UNAVAILABLE'
  | 'STORAGE_FULL'
  | 'RUNTIME_UNAVAILABLE'
  | 'INFERENCE_FAILED'
  | 'WORKER_FAILED'
  | 'CANCELLED'
  | 'DECODING_FAILED'
  | 'ENCODING_FAILED'
  | 'INTERNAL';

export class UpscalerError extends Error {
  readonly code: UpscalerErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: UpscalerErrorCode,
    message: string,
    options?: { cause?: unknown; details?: Record<string, unknown> },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'UpscalerError';
    this.code = code;
    if (options?.details) this.details = options.details;
    // Keep `instanceof` working when the bundle is transpiled down to ES5.
    Object.setPrototypeOf(this, UpscalerError.prototype);
  }

  /** Rebuild an error that crossed a `postMessage` boundary. */
  static fromSerialized(value: unknown): UpscalerError {
    if (value instanceof UpscalerError) return value;
    if (
      typeof value === 'object' &&
      value !== null &&
      'code' in value &&
      typeof (value as { code: unknown }).code === 'string'
    ) {
      const v = value as { code: UpscalerErrorCode; message?: string; details?: Record<string, unknown> };
      return new UpscalerError(v.code, v.message ?? v.code, { details: v.details });
    }
    return new UpscalerError('INTERNAL', String(value));
  }

  toJSON(): { name: string; code: UpscalerErrorCode; message: string; details?: Record<string, unknown> } {
    return { name: this.name, code: this.code, message: this.message, details: this.details };
  }
}

export class CancellationError extends UpscalerError {
  constructor(message = 'Operation cancelled') {
    super('CANCELLED', message);
    this.name = 'CancellationError';
    Object.setPrototypeOf(this, CancellationError.prototype);
  }
}

export function isCancellation(error: unknown): boolean {
  if (error instanceof UpscalerError) return error.code === 'CANCELLED';
  return error instanceof Error && error.name === 'AbortError';
}

/** Throws `CancellationError` if `signal` has already been aborted. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CancellationError();
}
