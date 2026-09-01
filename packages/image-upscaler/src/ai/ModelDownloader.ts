import { CancellationError, UpscalerError, isCancellation } from '../core/errors.js';
import type { DownloadOptions, DownloadProgress } from '../core/types.js';
import type { ResolvedModel } from './ModelRegistry.js';

/**
 * Model fetching.
 *
 * Three things this has to get right, none of which `fetch(url)` gives you:
 * streaming progress on a 67 MB download, integrity verification before the
 * bytes are handed to a runtime, and retry that does not silently return a
 * truncated body.
 */

const DEFAULT_RETRIES = 2;

export interface DownloadResult {
  bytes: ArrayBuffer;
  sha256: string;
}

export async function downloadModel(
  model: ResolvedModel,
  options: DownloadOptions = {},
): Promise<DownloadResult> {
  const retries = Math.max(0, options.retries ?? DEFAULT_RETRIES);
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const bytes = await fetchWithProgress(model, options);
      const sha256 = await sha256Hex(bytes);

      if (model.sha256 && sha256 !== model.sha256) {
        // Do not retry a checksum failure blindly - if the mirror is serving
        // the wrong file, retrying just downloads it again. One retry is
        // allowed in case of a genuinely corrupt transfer, then it is fatal.
        throw new UpscalerError(
          'MODEL_CORRUPTED',
          `Checksum mismatch for "${model.id}": expected ${model.sha256}, got ${sha256}`,
          { details: { modelId: model.id, expected: model.sha256, actual: sha256 } },
        );
      }
      return { bytes, sha256 };
    } catch (error) {
      lastError = error;
      if (isCancellation(error)) throw error;
      if (attempt === retries) break;
      if (error instanceof UpscalerError && error.code === 'MODEL_CORRUPTED' && attempt > 0) break;
      // Exponential backoff, capped. A model server under load recovers; a
      // tight retry loop makes it worse.
      await delay(Math.min(4000, 400 * 2 ** attempt), options.signal);
    }
  }

  if (lastError instanceof UpscalerError) throw lastError;
  throw new UpscalerError(
    'MODEL_DOWNLOAD_FAILED',
    `Could not download "${model.id}" from ${model.url}`,
    { cause: lastError, details: { modelId: model.id, url: model.url } },
  );
}

async function fetchWithProgress(
  model: ResolvedModel,
  options: DownloadOptions,
): Promise<ArrayBuffer> {
  if (options.signal?.aborted) throw new CancellationError();

  let response: Response;
  try {
    response = await fetch(model.url, {
      signal: options.signal,
      // Weights are immutable and content-addressed by checksum; let the HTTP
      // cache serve them, but never a stale error page.
      cache: 'default',
      credentials: 'omit',
      redirect: 'follow',
    });
  } catch (error) {
    if (isCancellation(error)) throw new CancellationError();
    throw new UpscalerError('MODEL_DOWNLOAD_FAILED', `Network error fetching ${model.url}`, {
      cause: error,
    });
  }

  if (!response.ok) {
    throw new UpscalerError(
      'MODEL_DOWNLOAD_FAILED',
      `${model.url} responded ${response.status} ${response.statusText}`,
      { details: { status: response.status, url: model.url } },
    );
  }

  const declared = Number(response.headers.get('content-length'));
  const total = Number.isFinite(declared) && declared > 0 ? declared : null;
  const emit = makeThrottledEmitter(model.id, total, options.onProgress);

  // Without a readable stream (very old Safari, or an opaque response) fall
  // back to a single arrayBuffer read and report only start and finish.
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    emit(buffer.byteLength, true);
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (options.signal?.aborted) throw new CancellationError();
      chunks.push(value);
      loaded += value.byteLength;
      emit(loaded, false);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (isCancellation(error)) throw new CancellationError();
    throw new UpscalerError('MODEL_DOWNLOAD_FAILED', `Transfer of ${model.url} failed`, {
      cause: error,
    });
  }

  emit(loaded, true);

  // A truncated body that still returned 200 is a real failure mode behind
  // flaky proxies. Catch it here rather than letting the ONNX parser do it.
  if (total !== null && loaded !== total) {
    throw new UpscalerError(
      'MODEL_DOWNLOAD_FAILED',
      `Truncated download for "${model.id}": got ${loaded} of ${total} bytes`,
      { details: { loaded, total } },
    );
  }

  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

function makeThrottledEmitter(
  modelId: string,
  total: number | null,
  onProgress: ((progress: DownloadProgress) => void) | undefined,
): (loaded: number, force: boolean) => void {
  if (!onProgress) return () => undefined;
  let last = 0;
  return (loaded, force) => {
    const now = Date.now();
    if (!force && now - last < 100) return;
    last = now;
    onProgress({
      modelId,
      loaded,
      total,
      progress: total !== null ? Math.min(1, loaded / total) : null,
    });
  };
}

/**
 * SHA-256 via WebCrypto. Available in every browser this library targets, and
 * in Workers; `crypto.subtle` is only missing on insecure origins, where model
 * downloading is a bad idea anyway.
 */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new UpscalerError(
      'RUNTIME_UNAVAILABLE',
      'WebCrypto is unavailable, so model integrity cannot be verified. This usually means an insecure (non-HTTPS) origin.',
    );
  }
  const digest = await subtle.digest('SHA-256', bytes);
  const view = new Uint8Array(digest);
  let hex = '';
  for (const byte of view) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancellationError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new CancellationError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
