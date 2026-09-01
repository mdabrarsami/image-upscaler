import { UpscalerError } from './errors.js';
import type { EngineName, OutputFormat, RuntimeName, UpscaleResult } from './types.js';

export interface UpscaleResultInit {
  blob: Blob;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  scale: number;
  engine: EngineName;
  runtime: RuntimeName;
  processingTime: number;
  format: OutputFormat;
}

/**
 * The object handed back from `upscale()`.
 *
 * A class rather than a plain object so the convenience methods travel with
 * the data, and so `toObjectURL` can hand out one stable URL instead of
 * leaking a new one on every call.
 */
export class UpscaleResultImpl implements UpscaleResult {
  readonly blob: Blob;
  readonly width: number;
  readonly height: number;
  readonly originalWidth: number;
  readonly originalHeight: number;
  readonly scale: number;
  readonly engine: EngineName;
  readonly runtime: RuntimeName;
  readonly processingTime: number;
  readonly format: OutputFormat;

  private objectUrl: string | undefined;

  constructor(init: UpscaleResultInit) {
    this.blob = init.blob;
    this.width = init.width;
    this.height = init.height;
    this.originalWidth = init.originalWidth;
    this.originalHeight = init.originalHeight;
    this.scale = init.scale;
    this.engine = init.engine;
    this.runtime = init.runtime;
    this.processingTime = init.processingTime;
    this.format = init.format;
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    return this.blob.arrayBuffer();
  }

  /**
   * Memoised, so repeated calls in a render loop do not leak. Call
   * `revokeObjectURL()` when the image is no longer displayed.
   */
  toObjectURL(): string {
    if (typeof URL === 'undefined' || !URL.createObjectURL) {
      throw new UpscalerError('RUNTIME_UNAVAILABLE', 'URL.createObjectURL is not available here');
    }
    this.objectUrl ??= URL.createObjectURL(this.blob);
    return this.objectUrl;
  }

  revokeObjectURL(): void {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = undefined;
    }
  }

  download(filename?: string): void {
    if (typeof document === 'undefined') {
      throw new UpscalerError(
        'RUNTIME_UNAVAILABLE',
        'download() needs a DOM. Outside the main thread, transfer result.blob and save it there.',
      );
    }
    const url = URL.createObjectURL(this.blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename ?? `upscaled-${this.width}x${this.height}.${this.format}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Revoking synchronously cancels the download in some browsers; one turn
    // of the event loop is enough for the navigation to have started.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  toJSON(): Omit<UpscaleResultInit, 'blob'> & { size: number } {
    return {
      width: this.width,
      height: this.height,
      originalWidth: this.originalWidth,
      originalHeight: this.originalHeight,
      scale: this.scale,
      engine: this.engine,
      runtime: this.runtime,
      processingTime: this.processingTime,
      format: this.format,
      size: this.blob.size,
    };
  }
}
