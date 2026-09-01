import { UpscalerError } from '../core/errors.js';
import type { ModelDefinition } from '../core/types.js';

/**
 * The model catalogue.
 *
 * Nothing anywhere else in the library knows a model URL. Everything - the
 * downloader, the cache, the inference session - takes a `ModelDefinition`.
 * That is what makes the catalogue swappable: point it at your own host, an
 * internal mirror, or a bundled asset path, and the rest of the library does
 * not change.
 *
 * Every built-in entry carries a SHA-256 and a license, and both are verified
 * rather than assumed: see docs/MODELS.md for how the values were obtained.
 */

/**
 * Real-ESRGAN RRDBNet, exported to ONNX with dynamic spatial dimensions.
 *
 * BSD-3-Clause, matching the upstream xinntao/Real-ESRGAN release, so
 * redistribution is permitted with attribution. Input is NCHW float RGB in
 * [0, 1]; the tensor names are literally `input` and `output`.
 *
 * The 512 px tile is the export author's own recommendation and matches what
 * the memory planner would pick anyway: at 4x, a 512 px tile produces a
 * 2048x2048 output tensor, which is 64 MiB of float - large enough to be
 * efficient, small enough to fit a default WebGPU storage binding.
 */
export const BUILTIN_MODELS: readonly ModelDefinition[] = Object.freeze([
  Object.freeze({
    id: 'realesrgan-x4',
    name: 'Real-ESRGAN 4x (RRDBNet)',
    scale: 4,
    size: 67_051_616,
    version: '1.0.0',
    license: 'BSD-3-Clause',
    source: 'https://huggingface.co/SceneWorks/real-esrgan-onnx',
    attribution: 'Real-ESRGAN by Xintao Wang et al. (xinntao/Real-ESRGAN), ONNX export by SceneWorks',
    url: 'https://huggingface.co/SceneWorks/real-esrgan-onnx/resolve/main/real_esrgan_x4.onnx',
    sha256: '5c586662929cbc686c1a5c38d9c060dbdb4ea5863a1f7672b8c0761e6b89c033',
    preferredTileSize: 512,
    tileOverlap: 16,
    channels: 3,
    inputRange: [0, 1],
    layout: 'nchw',
  }),
  Object.freeze({
    id: 'realesrgan-x2',
    name: 'Real-ESRGAN 2x (RRDBNet)',
    scale: 2,
    size: 67_073_434,
    version: '1.0.0',
    license: 'BSD-3-Clause',
    source: 'https://huggingface.co/SceneWorks/real-esrgan-onnx',
    attribution: 'Real-ESRGAN by Xintao Wang et al. (xinntao/Real-ESRGAN), ONNX export by SceneWorks',
    url: 'https://huggingface.co/SceneWorks/real-esrgan-onnx/resolve/main/real_esrgan_x2.onnx',
    sha256: '7115ba92e8a1bfa63d68558ef006ef3d91273a068d321b1439f8bb1c9179002c',
    preferredTileSize: 512,
    tileOverlap: 16,
    channels: 3,
    inputRange: [0, 1],
    layout: 'nchw',
  }),
] as ModelDefinition[]);

export interface ResolvedModel extends Required<Omit<ModelDefinition, 'sha256' | 'attribution'>> {
  sha256?: string;
  attribution?: string;
}

const DEFAULTS = {
  preferredTileSize: 256,
  tileOverlap: 16,
  channels: 3 as const,
  inputRange: [0, 1] as [number, number],
  layout: 'nchw' as const,
};

/** A mutable catalogue. One instance per `ImageUpscaler`. */
export class ModelRegistry {
  private readonly models = new Map<string, ResolvedModel>();

  constructor(definitions: readonly ModelDefinition[] = BUILTIN_MODELS) {
    for (const definition of definitions) this.register(definition);
  }

  register(definition: ModelDefinition): ResolvedModel {
    validate(definition);
    const resolved: ResolvedModel = { ...DEFAULTS, ...stripUndefined(definition) } as ResolvedModel;
    this.models.set(resolved.id, resolved);
    return resolved;
  }

  unregister(id: string): boolean {
    return this.models.delete(id);
  }

  has(id: string): boolean {
    return this.models.has(id);
  }

  get(id: string): ResolvedModel {
    const model = this.models.get(id);
    if (!model) {
      throw new UpscalerError('MODEL_NOT_FOUND', `No model registered with id "${id}"`, {
        details: { id, available: this.ids() },
      });
    }
    return model;
  }

  ids(): string[] {
    return [...this.models.keys()];
  }

  all(): ResolvedModel[] {
    return [...this.models.values()];
  }

  /**
   * Best model for a requested scale.
   *
   * An exact match wins. Otherwise the largest native scale that divides the
   * request is used and the remainder is left to the caller - running the 2x
   * network twice for 4x is worse than running the 4x network once, but far
   * better than refusing.
   */
  findForScale(scale: number): ResolvedModel | undefined {
    const candidates = this.all();
    const exact = candidates.find((m) => m.scale === scale);
    if (exact) return exact;
    const divisors = candidates
      .filter((m) => m.scale > 1 && scale % m.scale === 0)
      .sort((a, b) => b.scale - a.scale);
    if (divisors.length > 0) return divisors[0];
    // Nothing divides cleanly: take the largest model no bigger than the ask,
    // and let the classical engine cover the remaining fractional factor.
    return candidates
      .filter((m) => m.scale <= scale)
      .sort((a, b) => b.scale - a.scale)[0];
  }
}

function validate(definition: ModelDefinition): void {
  const problems: string[] = [];
  if (!definition.id || typeof definition.id !== 'string') problems.push('id must be a non-empty string');
  if (!definition.url || typeof definition.url !== 'string') problems.push('url must be a non-empty string');
  if (!Number.isFinite(definition.scale) || definition.scale < 1) problems.push('scale must be >= 1');
  if (!Number.isFinite(definition.size) || definition.size <= 0) problems.push('size must be > 0');
  if (!definition.license) problems.push('license is required');

  if (definition.url) {
    let url: URL;
    try {
      url = new URL(definition.url, typeof location !== 'undefined' ? location.href : 'https://localhost/');
    } catch {
      problems.push(`url is not a valid URL: ${definition.url}`);
      url = new URL('https://localhost/');
    }
    // A model is code as far as the runtime is concerned. Refusing plaintext
    // transport is cheap and closes an obvious tampering vector.
    if (url.protocol !== 'https:' && url.protocol !== 'blob:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
      problems.push(`model URLs must use https (got ${url.protocol})`);
    }
  }
  if (definition.sha256 && !/^[0-9a-f]{64}$/.test(definition.sha256)) {
    problems.push('sha256 must be 64 lowercase hex characters');
  }
  if (definition.layout && definition.layout !== 'nchw') {
    problems.push(`unsupported tensor layout: ${definition.layout}`);
  }
  if (definition.channels !== undefined && definition.channels !== 3 && definition.channels !== 4) {
    problems.push('channels must be 3 or 4');
  }

  if (problems.length > 0) {
    throw new UpscalerError(
      'INVALID_OPTIONS',
      `Invalid model definition "${definition.id ?? '(no id)'}": ${problems.join('; ')}`,
      { details: { problems } },
    );
  }
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, v] of Object.entries(value)) {
    if (v !== undefined) (out as Record<string, unknown>)[key] = v;
  }
  return out;
}
