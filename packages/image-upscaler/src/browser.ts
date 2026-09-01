/**
 * Script-tag entry point.
 *
 * Built as a self-executing bundle with no module wrapper. It installs a
 * single global, `ImageUpscaler`, which is the class itself - so
 * `new ImageUpscaler()` works exactly as it does under ESM - with the rest of
 * the API hung off it as statics:
 *
 *   const upscaler = new ImageUpscaler();
 *   const caps = await ImageUpscaler.detectCapabilities();
 *
 * The global is assigned here rather than through the bundler's `globalName`
 * option, because that would make the global a module namespace object and
 * `new ImageUpscaler()` would throw.
 */
import { ImageUpscaler } from './core/ImageUpscaler.js';
import { detectCapabilities, detectCapabilitiesSync } from './capabilities/detectCapabilities.js';
import { CancellationError, UpscalerError, isCancellation } from './core/errors.js';
import { ClassicalUpscaler } from './engines/ClassicalUpscaler.js';
import { AIUpscaler } from './engines/AIUpscaler.js';
import { HybridUpscaler } from './engines/HybridUpscaler.js';
import { ModelRegistry, BUILTIN_MODELS } from './ai/ModelRegistry.js';
import { ModelManager } from './ai/ModelManager.js';
import { ModelCache } from './ai/ModelCache.js';
import { getPreset, listModes, SUPPORTED_SCALES } from './core/presets.js';
import { resample, resampleByScale, nearestScale } from './algorithms/resample.js';
import { getKernel } from './algorithms/kernels.js';
import { VERSION } from './index.js';

const statics = {
  ImageUpscaler,
  detectCapabilities,
  detectCapabilitiesSync,
  UpscalerError,
  CancellationError,
  isCancellation,
  ClassicalUpscaler,
  AIUpscaler,
  HybridUpscaler,
  ModelRegistry,
  ModelManager,
  ModelCache,
  BUILTIN_MODELS,
  getPreset,
  listModes,
  SUPPORTED_SCALES,
  resample,
  resampleByScale,
  nearestScale,
  getKernel,
  VERSION,
} as const;

export type BrowserGlobal = typeof ImageUpscaler & typeof statics;

const globalClass = Object.assign(ImageUpscaler, statics) as BrowserGlobal;

declare global {
  var ImageUpscaler: BrowserGlobal;
}

// `globalThis` covers window, worker scope and Electron's renderer alike.
(globalThis as unknown as Record<string, unknown>).ImageUpscaler = globalClass;

export default globalClass;
