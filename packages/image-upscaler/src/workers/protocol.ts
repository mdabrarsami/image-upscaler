import type {
  EngineName,
  ModelDefinition,
  OutputFormat,
  RuntimeName,
  UpscaleMode,
  UpscaleOptions,
  UpscaleProgress,
} from '../core/types.js';

/**
 * Worker message protocol.
 *
 * Deliberately narrow. Only `upscale` crosses the boundary; model management
 * stays on the calling thread, because both sides share the same IndexedDB and
 * shipping 67 MB of weights through `postMessage` to achieve nothing would be
 * absurd.
 */

/** The subset of `UpscaleOptions` that survives structured cloning. */
export interface SerializableOptions {
  scale?: UpscaleOptions['scale'];
  engine?: UpscaleOptions['engine'];
  mode?: UpscaleMode;
  model?: string;
  output?: { format?: OutputFormat; quality?: number };
  tileSize?: number | 'auto';
  sharpening?: number;
  detail?: number;
  noiseReduction?: number;
  edgeProtection?: number;
  antiRinging?: number;
}

export interface WorkerConfig {
  engine?: UpscaleOptions['engine'];
  mode?: UpscaleMode;
  models?: ModelDefinition[];
  defaultModel?: string;
}

/** Pixels, already decoded, in the form the worker can rebuild a surface from. */
export interface TransferredImage {
  kind: 'raw';
  data: ArrayBuffer;
  width: number;
  height: number;
  /** Format the original file was in, when it is known. */
  sourceFormat: OutputFormat | null;
}

/** Everything the worker knows how to turn back into pixels. */
export type WorkerImagePayload = TransferredImage | Blob | ArrayBuffer | ImageBitmap;

export type WorkerRequest =
  | {
      type: 'upscale';
      id: number;
      image: WorkerImagePayload;
      options: SerializableOptions;
      config: WorkerConfig;
    }
  | { type: 'abort'; id: number }
  | { type: 'ping'; id: number };

export type WorkerResponse =
  | { type: 'progress'; id: number; progress: UpscaleProgress }
  | {
      type: 'result';
      id: number;
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
  | {
      type: 'error';
      id: number;
      error: { code: string; message: string; details?: Record<string, unknown> };
    }
  | { type: 'pong'; id: number };

/** Drop callbacks and the signal; everything else clones fine. */
export function toSerializableOptions(options: UpscaleOptions): SerializableOptions {
  const {
    signal: _signal,
    onProgress: _onProgress,
    ...rest
  } = options;
  return rest;
}
