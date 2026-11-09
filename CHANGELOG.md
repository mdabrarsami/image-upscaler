# Changelog

## 0.1.0

First release.

### Core

- Classical upscaling pipeline: bilateral denoise, Lanczos resampling,
  anti-ringing, structure-tensor edge-directed refinement, detail
  reconstruction, adaptive sharpening with halo suppression.
- Optional local AI super-resolution (Real-ESRGAN via ONNX Runtime Web) on
  WebGPU or WebAssembly, plus a hybrid engine that combines the network's
  structure with the source's real detail.
- Scales 2x, 3x, 4x, 8x. Five tuning modes.
- Nine accepted input types; PNG, JPEG and WebP output.
- Web Worker execution by default, with a main-thread fallback.
- Automatic tiling, bit-identical to a single pass.
- Typed errors, throttled progress, and cancellation that reaches decoding,
  tiling, inference and encoding.
- Model registry, IndexedDB cache, checksum verification, offline operation.

### Distribution

- ESM, CJS, IIFE and a prebuilt ESM bundle; TypeScript declarations; source
  maps.
- `@mdabrarsami/image-upscaler-react` with `useImageUpscaler` and `useModels`.
- Zero runtime dependencies; the AI runtime is an optional peer behind a
  dynamic import.
