# API

Everything re-exported from `src/index.ts` is public and covered by semantic
versioning. Anything reachable only through a deep import is an implementation
detail.

Two entry points:

| Specifier | Contents |
|---|---|
| `@mdabrarsami/image-upscaler` | Everything below |
| `@mdabrarsami/image-upscaler/ai` | The AI surface on its own, for bundlers that want it in a separate chunk |

---

## `ImageUpscaler`

The front door. Long-lived by design: it caches the GPU device, compiled
shaders, filter weight tables and inference sessions.

```ts
new ImageUpscaler(config?: ImageUpscalerConfig)
```

### `ImageUpscalerConfig`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `engine` | `'auto' \| 'classical' \| 'ai' \| 'hybrid'` | `'auto'` | Default engine for every call |
| `mode` | `UpscaleMode` | `'balanced'` | Default tuning preset |
| `useWorker` | `boolean` | `true` where Workers exist | Run off the calling thread |
| `models` | `ModelDefinition[]` | built-in catalogue | Replace the model catalogue entirely |
| `defaultModel` | `string` | — | Model id `auto` should prefer |
| `onnxRuntimeLoader` | `() => Promise<unknown>` | dynamic `import('onnxruntime-web')` | Supply the AI runtime yourself |
| `workerUrl` | `string \| URL` | resolved from `import.meta.url` | Where the worker bundle lives |
| `logger` | `Logger` | console, warnings and errors only | Diagnostics sink |

Two of those need explanation.

`onnxRuntimeLoader` exists because the prebuilt browser bundles keep
`onnxruntime-web` external — a script-tag consumer has no module resolver, and
a classical-only consumer should not pay for a runtime they never use. Under a
bundler you never need it. Loading from a bare `<script>` or a raw ESM URL, you
do. A loader may configure `ort.env` before returning; the library only
overrides `wasm.numThreads`, and only to cap it at what the page can actually
use.

`workerUrl` exists for the same reason in reverse: `new URL('./worker.js',
import.meta.url)` is the shape bundlers recognise, and a classic script has no
`import.meta`. Omitting it there is not fatal — the library warns and runs on
the calling thread.

### Methods

```ts
upscale(input: UpscaleInput, options?: UpscaleOptions): Promise<UpscaleResult>
capabilities(): Promise<Capabilities>
warmUp(): Promise<void>
dispose(): Promise<void>
readonly models: ModelManager
```

`warmUp()` acquires the GPU adapter and compiles shaders without running a job.
Worth calling on an idle callback if you know an upscale is coming; entirely
optional, and it never throws.

`dispose()` releases the GPU device, inference sessions, the worker and every
cache. The instance is unusable afterwards.

---

## `upscale()`

### Input

```ts
type UpscaleInput =
  | Blob | File
  | ArrayBuffer | ArrayBufferView
  | ImageData | ImageBitmap
  | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas;
```

Binary inputs are decoded by the browser, so format support is the browser's:
PNG, JPEG, WebP, GIF, AVIF and anything else it handles. The format is sniffed
from the bytes rather than trusted from `File.type`, which is frequently wrong.

When the job runs in a Worker, DOM inputs (`HTMLImageElement`,
`HTMLCanvasElement`) are decoded on the calling thread first — they cannot
cross a thread boundary — and the pixels are transferred. Buffers you own are
copied before transfer, so nothing you passed in is detached.

### `UpscaleOptions`

| Option | Type | Default | Meaning |
|---|---|---|---|
| `scale` | `2 \| 3 \| 4 \| 8` | `2` | Magnification |
| `engine` | `'auto' \| 'classical' \| 'ai' \| 'hybrid'` | from config | See below |
| `mode` | `UpscaleMode` | from config | Tuning preset |
| `model` | `string` | best match for `scale` | Model id, for `ai`/`hybrid` |
| `output.format` | `'png' \| 'jpeg' \| 'webp'` | the input's format | |
| `output.quality` | `number` 0..1 | `0.92` | Ignored for PNG |
| `tileSize` | `number \| 'auto'` | `'auto'` | Source-pixel tile edge |
| `workingSpace` | `'srgb' \| 'linear'` | `'srgb'` | Colour space the filters work in |
| `sharpening` | `number` 0..1 | from mode | |
| `detail` | `number` 0..1 | from mode | |
| `noiseReduction` | `number` 0..1 | from mode | |
| `edgeProtection` | `number` 0..1 | from mode | |
| `antiRinging` | `number` 0..1 | from mode | |
| `signal` | `AbortSignal` | — | |
| `onProgress` | `(p: UpscaleProgress) => void` | — | Throttled to ~20 Hz |

Out-of-range strengths are clamped rather than rejected; non-finite ones fall
back to the preset.

`workingSpace` defaults to `srgb` on the strength of measurement, not
convention — linear light scores 1 to 2 dB PSNR *worse* on the benchmark suite.
[ALGORITHMS.md](ALGORITHMS.md#colour-space) has the reasoning and the numbers.

### Engine selection

`'classical'`, `'ai'` and `'hybrid'` are honoured or they fail loudly. An
explicit `engine: 'ai'` with no model installed throws `MODEL_NOT_INSTALLED`
rather than quietly producing a classical result — an engine setting that
silently means something else is worse than an error.

`'auto'` picks AI when a model is *already installed* and the device can run it,
and classical otherwise. It never downloads 67 MB on a user's behalf, and it
never picks AI for `mode: 'pixel-art'`. Any failure constructing the AI engine
falls back to classical with a warning.

### `UpscaleResult`

```ts
interface UpscaleResult {
  readonly blob: Blob;
  readonly width: number;
  readonly height: number;
  readonly originalWidth: number;
  readonly originalHeight: number;
  readonly scale: number;
  readonly engine: 'classical' | 'ai' | 'hybrid';
  readonly runtime: 'webgpu' | 'webgl' | 'wasm' | 'cpu';
  readonly processingTime: number;   // ms, decode and encode included
  readonly format: 'png' | 'jpeg' | 'webp';

  arrayBuffer(): Promise<ArrayBuffer>;
  toObjectURL(): string;             // memoised
  revokeObjectURL(): void;
  download(filename?: string): void; // browser only
}
```

`engine` and `runtime` report what actually ran, not what was requested. If you
asked for `auto` and got `classical` on `cpu`, that is what happened.

`toObjectURL()` is memoised, so calling it in a render loop does not leak. Call
`revokeObjectURL()` when the image is no longer displayed.

### Output format

If you do not specify one, the input's format is kept — with one exception: an
image with real transparency is never written as JPEG, because that would
silently flatten the alpha against a colour you did not choose. It becomes PNG
instead.

When you *do* ask for JPEG on a transparent image, the alpha is flattened
against white rather than the canvas default of black, which would put a dark
halo around every cut-out.

---

## Progress

```ts
interface UpscaleProgress {
  progress: number;          // 0..1, never decreases
  stage: 'decoding' | 'analyzing' | 'upscaling' | 'reconstructing'
       | 'sharpening' | 'encoding' | 'complete';
  currentTile?: number;      // 1-based, only while tiling
  totalTiles?: number;
}
```

The final event is always exactly `{ progress: 1, stage: 'complete' }`.

Throttling is not optional politeness: a tiled 8x run generates tens of
thousands of internal updates, and forwarding them all would cost more than the
work being reported.

---

## Errors

```ts
class UpscalerError extends Error {
  readonly code: UpscalerErrorCode;
  readonly details?: Record<string, unknown>;
}
```

```ts
try {
  await upscaler.upscale(file, { scale: 8 });
} catch (error) {
  if (error instanceof UpscalerError) {
    switch (error.code) {
      case 'MODEL_NOT_INSTALLED': /* offer the download */ break;
      case 'OUT_OF_MEMORY':       /* suggest a smaller scale */ break;
      case 'CANCELLED':           /* the user's own doing */ break;
    }
  }
}
```

| Code | When |
|---|---|
| `INVALID_INPUT` | Not an image, or an empty buffer |
| `INVALID_OPTIONS` | An unsupported scale, or a malformed model definition |
| `UNSUPPORTED_FORMAT` | The browser cannot encode the requested format |
| `IMAGE_TOO_LARGE` | Output beyond the 268 megapixel addressable ceiling |
| `OUT_OF_MEMORY` | The result would not fit even tiled |
| `GPU_UNAVAILABLE` | No WebGPU adapter |
| `GPU_LOST` | The device went away mid-run |
| `MODEL_NOT_FOUND` | No such id in the registry |
| `MODEL_NOT_INSTALLED` | Registered but not downloaded |
| `MODEL_DOWNLOAD_FAILED` | Network error, HTTP error, or a truncated body |
| `MODEL_CORRUPTED` | Checksum mismatch. The cached copy is discarded |
| `STORAGE_UNAVAILABLE` | No IndexedDB (some private-browsing modes) |
| `STORAGE_FULL` | Quota exceeded |
| `RUNTIME_UNAVAILABLE` | No canvas, no WebCrypto, or the AI runtime would not load |
| `INFERENCE_FAILED` | The network failed to run |
| `WORKER_FAILED` | The Worker could not start or crashed |
| `DECODING_FAILED` | The browser could not decode the bytes |
| `ENCODING_FAILED` | The browser could not encode the result |
| `CANCELLED` | An `AbortSignal` fired |
| `INTERNAL` | A bug. Please report it |

`isCancellation(error)` recognises both `CANCELLED` and a DOM `AbortError`.
Errors survive the Worker boundary with their code and details intact.

---

## Models

`upscaler.models` is a `ModelManager`.

```ts
list(): Promise<ModelInfo[]>
isInstalled(id: string): Promise<boolean>
download(id: string, options?: DownloadOptions): Promise<ArrayBuffer>
load(id: string, options?: DownloadOptions): Promise<ArrayBuffer>
delete(id: string): Promise<boolean>
deleteAll(): Promise<void>
usage(): Promise<number>
register(definition: ModelDefinition): void
readonly registry: ModelRegistry
```

`download()` is idempotent, de-duplicates concurrent calls for the same id, and
returns the cached bytes when the version still matches. `load()` additionally
re-verifies the checksum and discards a corrupted cache entry.

```ts
interface DownloadOptions {
  signal?: AbortSignal;
  onProgress?: (p: DownloadProgress) => void;  // { progress, loaded, total, modelId }
  force?: boolean;    // re-download even if cached
  retries?: number;   // default 2, exponential backoff
}
```

`progress` is `null` when the server sends no `content-length`. A body that
arrives short of its declared length is rejected as `MODEL_DOWNLOAD_FAILED`
rather than handed to the ONNX parser to fail incomprehensibly.

See [MODELS.md](MODELS.md) for registering your own.

---

## Capabilities

```ts
const caps = await detectCapabilities();
```

```ts
interface Capabilities {
  webGPU: boolean;              // an adapter was actually obtained, not sniffed
  webGL: boolean;
  webGL2: boolean;
  offscreenCanvas: boolean;
  workers: boolean;
  wasm: boolean;
  wasmSimd: boolean;
  sharedArrayBuffer: boolean;
  createImageBitmap: boolean;
  indexedDB: boolean;
  maxTextureSize: number | null;
  maxBufferSize: number | null;
  estimatedMemory: number;
  estimatedMemoryIsReported: boolean;
  encodableFormats: OutputFormat[];
  hardwareConcurrency: number;
}
```

Everything is probed, never inferred from the user agent. `webGPU` is true only
if an adapter was genuinely returned.

`estimatedMemoryIsReported` matters: browsers do not expose available memory.
When it is `false`, `estimatedMemory` is a conservative guess and should be
treated as an order of magnitude. `detectCapabilitiesSync()` returns the subset
that needs no `await`.

---

## Lower-level exports

Useful on their own, and what makes tree-shaking worthwhile. A thumbnailer that
only wants a good resize can import `resample` and nothing else.

**Resampling** — `resample`, `resampleByScale`, `nearestScale`,
`WeightTableCache`, `buildWeightTable`, `getKernel`, and the kernels
`lanczos(a)`, `lanczos2/3/4`, `bicubic`, `bilinear`, `mitchell`, `box`,
`cubicBC(B, C)`.

**Filters** — `blurPlane`, `blurSurface`, `gaussianKernel1D`, `gradient`,
`gradientMagnitude`, `gradientOrientation`, `structureTensor`, `analyzeTensor`,
`edgeDirectedRefine`, `adaptiveSharpen`, `suppressHalos`, `localContrast`,
`extractDetail`, `reconstructDetail`, `transferDetail`, `bilateralDenoise`,
`estimateNoise`, `antiRing`, `antiRingLocal`.

**Pixels** — `createSurface`, `cloneSurface`, `surfaceFromImageData`,
`surfaceToUint8`, `surfaceBytes`, `extractRegion`, `blitRegion`, `toLinear`,
`toSrgb`, `srgbToLinear`, `linearToSrgb`, `lumaPlane`, `premultiply`,
`unpremultiply`, `hasTransparency`, `bleedEdges`, `decodeInput`, `sniffFormat`,
`encodeSurface`, `chooseOutputFormat`, `surfaceToImageData`.

**Planning** — `estimateMemoryBudget`, `estimateProcessingMemory`,
`chooseTileSize`, `formatBytes`, `MAX_OUTPUT_PIXELS`, `planTiles`,
`singleTile`, `blendWeight`.

**Engines and GPU** — `ClassicalUpscaler`, `AIUpscaler`, `HybridUpscaler`,
`GPUResampler`, `WebGPUContext`, `UpscalerController`.

**Presets** — `getPreset`, `listModes`, `resolveTuning`, `SUPPORTED_SCALES`.

### `Surface`

The internal pixel container, and the currency of every low-level function:

```ts
interface Surface {
  data: Float32Array;    // interleaved RGBA, nominal 0..1
  width: number;
  height: number;
  colorSpace: 'srgb' | 'linear';
  premultiplied: boolean;
}
```

Float, not `Uint8`, because the pipeline is a chain of ten passes and 8-bit
intermediates band visibly after two or three of them.

The `colorSpace` and `premultiplied` flags are load-bearing: `toLinear()` on an
already-linear surface is a no-op rather than a second conversion, and
`encodeSurface()` refuses a surface that is still premultiplied instead of
writing wrong pixels.

### Custom resampler

`ClassicalUpscaler` takes any `Resampler`, which is how the GPU path is
attached and how you would attach your own:

```ts
import { ClassicalUpscaler, GPUResampler } from '@mdabrarsami/image-upscaler';

const engine = new ClassicalUpscaler({
  resampler: await GPUResampler.create(),
});
```

A resampler that throws is dropped permanently and the CPU path takes over, so
a lost GPU degrades rather than fails.
