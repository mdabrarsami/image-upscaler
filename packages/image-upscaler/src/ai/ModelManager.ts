import { UpscalerError } from '../core/errors.js';
import type { DownloadOptions, Logger, ModelDefinition, ModelInfo } from '../core/types.js';
import { silentLogger } from '../core/logger.js';
import { ModelCache } from './ModelCache.js';
import { downloadModel, sha256Hex } from './ModelDownloader.js';
import { ModelRegistry, type ResolvedModel } from './ModelRegistry.js';

/**
 * The `upscaler.models` surface.
 *
 * Ties the catalogue, the cache, and the downloader together and is the only
 * thing consumers touch. Model bytes are handed out as `ArrayBuffer`; nothing
 * here knows what a tensor is.
 */
export class ModelManager {
  readonly registry: ModelRegistry;
  private readonly cache: ModelCache;
  private readonly logger: Logger;
  /** De-duplicates concurrent downloads of the same model. */
  private readonly inflight = new Map<string, Promise<ArrayBuffer>>();

  constructor(registry?: ModelRegistry, cache?: ModelCache, logger?: Logger) {
    this.registry = registry ?? new ModelRegistry();
    this.cache = cache ?? new ModelCache();
    this.logger = logger ?? silentLogger;
  }

  async list(): Promise<ModelInfo[]> {
    const installed = ModelCache.isAvailable()
      ? await this.cache.list().catch(() => [])
      : [];
    const installedByIdVersion = new Map(installed.map((e) => [`${e.id}@${e.version}`, e]));

    return this.registry.all().map((model) => ({
      id: model.id,
      name: model.name,
      scale: model.scale,
      size: model.size,
      version: model.version,
      license: model.license,
      source: model.source,
      attribution: model.attribution,
      installed: installedByIdVersion.has(`${model.id}@${model.version}`),
      preferredTileSize: model.preferredTileSize,
      tileOverlap: model.tileOverlap,
      channels: model.channels,
    }));
  }

  /** Add or replace a catalogue entry. Validation happens in the registry. */
  register(definition: ModelDefinition): void {
    this.registry.register(definition);
  }

  async isInstalled(id: string): Promise<boolean> {
    const model = this.registry.get(id);
    if (!ModelCache.isAvailable()) return false;
    return this.cache.has(id, model.version);
  }

  /**
   * Ensure a model is on disk and return its bytes.
   *
   * A cached entry whose version no longer matches the catalogue is treated as
   * absent and replaced, which is how a registry update rolls out new weights.
   */
  async download(id: string, options: DownloadOptions = {}): Promise<ArrayBuffer> {
    const model = this.registry.get(id);

    const existing = this.inflight.get(id);
    if (existing && !options.force) return existing;

    const task = this.doDownload(model, options).finally(() => {
      this.inflight.delete(id);
    });
    this.inflight.set(id, task);
    return task;
  }

  private async doDownload(model: ResolvedModel, options: DownloadOptions): Promise<ArrayBuffer> {
    const cacheable = ModelCache.isAvailable();

    if (cacheable && !options.force) {
      const cached = await this.cache.get(model.id).catch(() => undefined);
      if (cached && cached.version === model.version) {
        // Report instant completion so a progress UI does not sit at zero.
        options.onProgress?.({
          modelId: model.id,
          loaded: cached.size,
          total: cached.size,
          progress: 1,
        });
        return cached.bytes;
      }
    }

    if (cacheable) {
      const room = await ModelCache.hasRoomFor(model.size);
      if (room === false) {
        throw new UpscalerError(
          'STORAGE_FULL',
          `Not enough browser storage for "${model.id}" (${Math.round(model.size / 1e6)} MB)`,
          { details: { modelId: model.id, size: model.size } },
        );
      }
    }

    const { bytes, sha256 } = await downloadModel(model, options);

    if (cacheable) {
      try {
        await this.cache.put({
          id: model.id,
          version: model.version,
          bytes,
          sha256,
          storedAt: Date.now(),
          size: bytes.byteLength,
        });
      } catch (error) {
        // Being unable to *cache* is not being unable to *run*. Downgrade a
        // storage failure to a warning and return the bytes anyway.
        if (error instanceof UpscalerError && error.code === 'STORAGE_FULL') {
          this.logger.warn(`${error.message} Continuing without caching.`);
        } else {
          throw error;
        }
      }
    }

    return bytes;
  }

  /**
   * Load a model for inference, downloading it if necessary.
   *
   * Cached bytes are re-verified against the catalogue checksum. Storage can
   * be corrupted by a crash mid-write, and a malformed ONNX file produces a
   * far less actionable error from the runtime than "MODEL_CORRUPTED" does
   * from here.
   */
  async load(id: string, options: DownloadOptions = {}): Promise<ArrayBuffer> {
    const model = this.registry.get(id);
    const bytes = await this.download(id, options);

    if (model.sha256) {
      const actual = await sha256Hex(bytes);
      if (actual !== model.sha256) {
        await this.delete(id).catch(() => undefined);
        throw new UpscalerError(
          'MODEL_CORRUPTED',
          `Cached copy of "${id}" failed verification and has been discarded. Retry the download.`,
          { details: { modelId: id, expected: model.sha256, actual } },
        );
      }
    }
    return bytes;
  }

  async delete(id: string): Promise<boolean> {
    // Deleting a model that is not in the catalogue is still valid: the
    // catalogue may have been swapped since it was installed.
    if (!ModelCache.isAvailable()) return false;
    return this.cache.delete(id);
  }

  async deleteAll(): Promise<void> {
    if (!ModelCache.isAvailable()) return;
    await this.cache.clear();
  }

  /** Total bytes of installed models. */
  async usage(): Promise<number> {
    if (!ModelCache.isAvailable()) return 0;
    return this.cache.usage();
  }

  dispose(): void {
    this.cache.close();
    this.inflight.clear();
  }
}
