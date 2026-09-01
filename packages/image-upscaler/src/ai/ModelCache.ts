import { UpscalerError } from '../core/errors.js';

/**
 * Persistent model storage.
 *
 * IndexedDB rather than Cache Storage: Cache Storage keys on Request and is
 * tied to the fetch that produced it, which makes "the same weights from a
 * different mirror" awkward, and it is opaque to quota inspection. IndexedDB
 * stores a plain `ArrayBuffer` under a key the library controls, survives
 * reloads, works offline, and works identically inside a Worker.
 *
 * The stored record keeps the version and checksum alongside the bytes so a
 * catalogue update invalidates stale weights automatically.
 */

const DB_NAME = 'image-upscaler-models';
const DB_VERSION = 1;
const STORE = 'models';

export interface CachedModel {
  id: string;
  version: string;
  bytes: ArrayBuffer;
  sha256?: string;
  storedAt: number;
  size: number;
}

export interface CacheEntryInfo {
  id: string;
  version: string;
  size: number;
  storedAt: number;
  sha256?: string;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

export class ModelCache {
  private dbPromise: Promise<IDBDatabase> | undefined;

  static isAvailable(): boolean {
    return typeof indexedDB !== 'undefined';
  }

  private async open(): Promise<IDBDatabase> {
    if (!ModelCache.isAvailable()) {
      throw new UpscalerError(
        'STORAGE_UNAVAILABLE',
        'IndexedDB is unavailable, so models cannot be cached. Private-browsing modes sometimes block it.',
      );
    }
    this.dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(
          new UpscalerError('STORAGE_UNAVAILABLE', 'Could not open the model cache database', {
            cause: request.error,
          }),
        );
      // Another tab holding an old version open blocks the upgrade.
      request.onblocked = () =>
        reject(
          new UpscalerError(
            'STORAGE_UNAVAILABLE',
            'The model cache is locked by another tab; close it and retry',
          ),
        );
    });
    return this.dbPromise;
  }

  private async transaction<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => Promise<T>,
  ): Promise<T> {
    const db = await this.open();
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    try {
      const result = await run(store);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
      });
      return result;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        // Already finished; nothing to abort.
      }
      throw error;
    }
  }

  async get(id: string): Promise<CachedModel | undefined> {
    return this.transaction('readonly', (store) =>
      requestToPromise<CachedModel | undefined>(store.get(id) as IDBRequest<CachedModel | undefined>),
    );
  }

  async has(id: string, version?: string): Promise<boolean> {
    const entry = await this.get(id).catch(() => undefined);
    if (!entry) return false;
    return version === undefined || entry.version === version;
  }

  async put(entry: CachedModel): Promise<void> {
    try {
      await this.transaction('readwrite', (store) => requestToPromise(store.put(entry)));
    } catch (error) {
      // A quota failure is worth distinguishing: the fix (free space, or skip
      // caching) is different from a generic storage fault.
      if (isQuotaError(error)) {
        throw new UpscalerError(
          'STORAGE_FULL',
          `Not enough storage to cache "${entry.id}" (${Math.round(entry.size / 1e6)} MB). ` +
            'Delete an installed model or free browser storage.',
          { cause: error, details: { id: entry.id, size: entry.size } },
        );
      }
      throw error;
    }
  }

  async delete(id: string): Promise<boolean> {
    const existed = (await this.get(id).catch(() => undefined)) !== undefined;
    await this.transaction('readwrite', (store) => requestToPromise(store.delete(id)));
    return existed;
  }

  async list(): Promise<CacheEntryInfo[]> {
    return this.transaction('readonly', async (store) => {
      const all = await requestToPromise<CachedModel[]>(store.getAll() as IDBRequest<CachedModel[]>);
      return all.map(({ id, version, size, storedAt, sha256 }) => ({
        id,
        version,
        size,
        storedAt,
        sha256,
      }));
    });
  }

  async clear(): Promise<void> {
    await this.transaction('readwrite', (store) => requestToPromise(store.clear()));
  }

  /** Bytes currently held by cached models. */
  async usage(): Promise<number> {
    const entries = await this.list();
    return entries.reduce((sum, entry) => sum + entry.size, 0);
  }

  /**
   * Ask the browser whether a download of `bytes` is likely to fit. The
   * estimate is deliberately coarse and browsers round it, so this only
   * catches the clear-cut cases.
   */
  static async hasRoomFor(bytes: number): Promise<boolean | null> {
    const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined;
    if (!storage?.estimate) return null;
    try {
      const { quota, usage } = await storage.estimate();
      if (typeof quota !== 'number' || typeof usage !== 'number') return null;
      // Leave headroom; a quota that is exactly met still fails in practice.
      return quota - usage > bytes * 1.2;
    } catch {
      return null;
    }
  }

  close(): void {
    void this.dbPromise?.then((db) => db.close());
    this.dbPromise = undefined;
  }
}

function isQuotaError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED')
  );
}
