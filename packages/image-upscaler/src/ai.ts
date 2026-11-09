/**
 * `@mdabrarsami/image-upscaler/ai`
 *
 * The AI-only surface. Split out so a bundler can keep every reference to
 * ONNX Runtime out of an application that never asks for it - importing the
 * main entry point pulls in none of this, and the runtime itself is behind a
 * dynamic import even here.
 */

export {
  AIInferenceSession,
  loadOrt,
  resetOrtCache,
  surfaceToNCHW,
  nchwToSurface,
} from './ai/AIInference.js';
export type {
  InferenceSessionOptions,
  OrtLoader,
  OrtModuleLike,
  OrtSessionLike,
  OrtTensorLike,
} from './ai/AIInference.js';

export { AIUpscaler } from './engines/AIUpscaler.js';
export { HybridUpscaler } from './engines/HybridUpscaler.js';

export { ModelManager } from './ai/ModelManager.js';
export { ModelRegistry, BUILTIN_MODELS } from './ai/ModelRegistry.js';
export { ModelCache } from './ai/ModelCache.js';
export { downloadModel, sha256Hex } from './ai/ModelDownloader.js';
export type { DownloadResult } from './ai/ModelDownloader.js';
