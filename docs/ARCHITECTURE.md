# Architecture

## The shape of it

```
                    ImageUpscaler          <- the only class most consumers touch
                     |          |
              WorkerBridge   ModelManager  <- off-thread execution / weights
                     |          |
              UpscalerController           <- decode, plan, tile, encode
                     |
        +------------+-------------+
        |            |             |
  ClassicalUpscaler  AIUpscaler  HybridUpscaler
        |            |
   algorithms/    AIInference -> ONNX Runtime Web
        |
   GPUResampler (optional)
```

Two rules explain almost every decision below.

**The core is pure numerics.** Everything under `algorithms/` and `memory/`
operates on `Float32Array` and knows nothing about canvases, blobs or the DOM.
That is what lets the same code run on the main thread, inside a Worker where
`document` does not exist, and in an Electron renderer, with no forks and no
shims. The test suite proves it rather than asserting it: there is a Worker
test that fails if anything in the core reaches for a browser global.

**Every layer has one job.** The controller knows about tiling and never about
Lanczos. Engines know about Lanczos and never about tiling. Algorithms know
about neither.

## Layers

### `core/`

`ImageUpscaler` is the public facade: configuration, the Worker decision, the
result wrapper, disposal.

`UpscalerController` is the orchestrator, and owns everything true of a run
regardless of which engine does the arithmetic:

1. **Decode** the input to a `Surface`.
2. **Plan**: probe capabilities, pick an engine, decide tiling, measure the
   whole-image statistics that tiles must share.
3. **Execute** the tile plan.
4. **Encode** to a `Blob`.

`presets.ts` holds the mode table. Every mode drives the same pipeline and only
changes numbers, so a mode can never introduce behaviour the others cannot
express.

`progress.ts` maps per-stage fractions onto a monotonic, throttled 0..1.

### `engines/`

One interface:

```ts
upscaleSurface(src, scale, tuning, ctx): Promise<Surface>
```

Input and output are both sRGB with straight alpha. Engines convert to whatever
they need internally and convert back, so they compose and a caller never has to
track colour state.

Each engine also declares how it wants to be tiled — preferred tile size, halo
width, and whether write-back must be feathered — and the controller obeys.
That is the whole reason the classical path can be bit-exact under tiling while
the AI path cannot: they state different requirements rather than sharing one
compromise.

### `algorithms/`

Free functions on `Surface`. No classes, no state, no I/O. Each is independently
testable, and each is independently exported because a consumer who only wants
a good resize should not have to instantiate an engine to get one.

The layout is flat (`resample.ts`, `edges.ts`, `sharpening.ts`, …) rather than
one directory per algorithm. At this size a directory per file would be
ceremony.

### `image/`

The boundary between pixels and the platform. `decoder.ts` turns any accepted
input into a `Surface`; `encoder.ts` turns one back into a `Blob`; `color.ts`
and `alpha.ts` are pure maths and belong to the core.

Browser-native codecs are used deliberately. They are hardware-accelerated,
they already handle EXIF orientation and colour profiles, and they are already
in the binary. Shipping a PNG encoder to do the same job worse would be
indefensible in a library whose value proposition is being small enough to load
client-side.

### `memory/`

`MemoryManager` estimates the pipeline peak and decides whether to tile.
`TileManager` plans the grid. Both are pure arithmetic and heavily tested,
because getting them wrong means a crashed tab rather than a wrong pixel.

### `env/`

The adapter layer, and deliberately tiny: canvas creation, blob conversion,
`createImageBitmap` presence, `performance.now`, a yield. Only APIs whose
*shape* genuinely differs between hosts are abstracted. A general-purpose
platform layer would be mostly indirection.

### `gpu/`

`WebGPUContext` owns the device, caches pipelines and shader modules, and
watches `device.lost`. `GPUResampler` implements the public `Resampler`
interface, so it plugs into `ClassicalUpscaler` exactly as a consumer's own
implementation would.

Only the resample runs on the GPU. The other passes are cheap linear scans over
the same buffer, and the readback cost of bouncing each one across the bus
would eat the gain. The resample is different: O(pixels × taps), embarrassingly
parallel, and the single largest cost.

### `ai/`

`ModelRegistry` (the catalogue), `ModelCache` (IndexedDB), `ModelDownloader`
(streaming fetch, checksums, retry), `ModelManager` (the public surface), and
`AIInference` (the ONNX Runtime bridge).

Nothing outside the registry knows a model URL. That is what makes the
catalogue swappable: point it at your own host and nothing else changes.

### `workers/`

A narrow message protocol. Only `upscale` crosses the boundary. Model
management stays on the calling thread because both sides share the same
IndexedDB, and shipping 67 MB of weights through `postMessage` to achieve
nothing would be absurd.

## Decisions worth explaining

### Float32 pixels

The pipeline is ten passes deep. Eight-bit intermediates band visibly after two
or three, and the detail layer is a signed residual that 8 bits cannot even
represent. Sixteen bytes per pixel is the cost, and it is the reason
[large images are memory-bound](PERFORMANCE.md#limits).

### Premultiplied alpha, always

Filtering straight alpha averages the colour of fully transparent pixels into
visible ones, which is exactly where the classic dark fringe around a cut-out
PNG comes from. Every resample and convolution runs premultiplied, and
un-premultiplies once at the end.

This has a consequence that is easy to get wrong, and that this library got
wrong at first: on premultiplied data a pixel is `colour × alpha`, so a filter
preserves the colour **only if it scales every channel by the same factor**.
Sharpening RGB while leaving alpha alone shifts the hue of every partially
transparent pixel. The sharpener therefore derives one gain per pixel from luma
and applies it to all four channels, and the detail injector derives one
soft-clip factor per pixel the same way. There is a test for it.

### The working colour space is sRGB, and that was measured

Averaging gamma-encoded values is not physically correct, and the textbook
answer is to linearise first. The benchmark disagrees: linear-light Lanczos-3
scores 1 to 2 dB PSNR and 0.03 to 0.05 SSIM *worse* than the same kernel in
sRGB, consistently across sizes and factors.

The reason is that almost everything on the web was authored, composited and
antialiased in sRGB. Reconstructing it in the space it was created in is closer
to the truth than reconstructing it in the space light lives in. `linear`
remains available for content that genuinely represents light. See
[ALGORITHMS.md](ALGORITHMS.md#colour-space).

### Tiling is the only execution path

A small image is a one-tile plan, not a special case.

There used to be an unpadded fast path for images that fitted in memory, and it
disagreed with the tiled path along the image border by up to 15 of 255 levels.
The cause is subtle: a tile's halo is clamp-extended in *source* space and then
upscaled, whereas an unpadded pass clamps in *output* space, and those are
different extensions. Keeping one path costs one extra region copy and makes
tiled and untiled output bit-identical by construction. The suite asserts
exactly that, across tile sizes from 16 to whole-image, at 2x and 4x.

### Global statistics are measured once and passed down

A tile cannot compute a global statistic: it would get a different answer from
the whole frame, and neighbouring tiles would get different answers from each
other. That shows up as banding along the tile grid.

Two things in this pipeline were originally whole-image reductions — the noise
estimate, and a percentile used to normalise the sharpener's edge mask. Both
produced visible seams. The noise estimate now travels in `EngineContext`; the
percentile was replaced by a fixed reference constant, because an adaptive
normalisation is fundamentally incompatible with independent tiles.

### AI tiles are feathered; classical tiles are not

The classical chain has a hard filter support radius, so a halo of 16 source
pixels makes a tile's interior provably identical to a whole-image pass. A
convolutional network has no such radius — its effective receptive field is
soft — so the AI path uses a wider halo and a smoothstep-feathered accumulate,
normalised by an accumulated weight buffer.

Feathering is the weaker guarantee, so it is used only where the stronger one
is unavailable.

### The AI runtime is never statically imported

`onnxruntime-web` is multiple megabytes of WASM and glue. It sits behind a
dynamic import, is an optional peer dependency, and has its own package entry
point (`/ai`). An application that only uses the classical engine never fetches
it — verified by a Playwright test that watches the network while running a
classical upscale through the built React app.

### Errors are typed and cross threads intact

`UpscalerError` carries a stable `code` and structured `details`, serialises to
JSON, and is reconstructed on the far side of `postMessage`. A consumer can
branch on `MODEL_NOT_INSTALLED` and offer a download button; they cannot branch
on a message string.

### Engine requests are honoured or they fail

`engine: 'ai'` with no model throws. It would be friendlier to fall back
silently, and it would be wrong: the caller asked for a specific engine, and an
engine setting that quietly means something else is worse than an error.
`'auto'` is the setting that means "whatever works", and it falls back freely.

## Data flow, end to end

```
File
 |  decoder: browser codec -> ImageData -> Surface (sRGB, straight alpha)
 v
Surface
 |  controller: capabilities, engine choice, memory estimate, tile plan,
 |              whole-image statistics
 v
per tile: extractRegion(padded)
 |
 |  engine: premultiply -> [linearise] -> denoise -> extract detail
 |          -> resample -> anti-ring -> edge-direct -> inject detail
 |          -> sharpen -> un-premultiply -> [de-linearise]
 v
blitRegion (hard cut) or feathered accumulate
 |
 v
Surface -> encoder: putImageData -> canvas -> Blob
 |
 v
UpscaleResult
```

## Testing seams

The architecture exists partly to be testable:

- Algorithms are free functions, so they are tested on synthetic images with
  exactly assertable properties.
- Engines take an `EngineContext`, so tiling, cancellation and progress are
  testable without a browser.
- `Resampler` is an interface, so the GPU path is comparable against the CPU
  path numerically rather than visually.
- The model registry is injectable, so download failure, corruption and quota
  exhaustion are testable without breaking anything.

See [TESTING.md](TESTING.md).
