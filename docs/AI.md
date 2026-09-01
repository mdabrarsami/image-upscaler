# The AI engine

Optional, local, and off by default.

## What it is

A super-resolution neural network — by default Real-ESRGAN (RRDBNet) exported
to ONNX — running in your browser through [ONNX Runtime
Web](https://onnxruntime.ai/docs/tutorials/web/), on WebGPU where available and
WebAssembly otherwise.

The weights are downloaded once, verified against a SHA-256, cached in
IndexedDB, and used offline thereafter. Pixels are never sent anywhere. See
[PRIVACY.md](PRIVACY.md), which describes the test that watches every request
the page makes.

## Getting it running

### Under a bundler

```bash
npm install onnxruntime-web
```

```ts
const upscaler = new ImageUpscaler();
await upscaler.models.download('realesrgan-x4', {
  onProgress: ({ progress }) => setProgress(progress),
});
const result = await upscaler.upscale(file, { scale: 4, engine: 'ai' });
```

The runtime is behind a dynamic import, so your bundler emits it as a separate
chunk and a user who never touches the AI engine never downloads it.

### Without a bundler

The prebuilt browser bundles keep `onnxruntime-web` external, because a
script-tag consumer has no module resolver and a classical-only consumer should
not pay for a runtime they will not use. Supply the loader yourself:

```ts
const ORT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/';

const upscaler = new ImageUpscaler({
  onnxRuntimeLoader: async () => {
    const ort = await import(`${ORT}ort.wasm.bundle.min.mjs`);
    // The bundle fetches its own .wasm at runtime and looks for it beside the
    // *page* unless told otherwise.
    ort.env.wasm.wasmPaths = ORT;
    return ort;
  },
});
```

A custom loader is a function, and functions do not survive `postMessage`. The
library detects that and keeps AI runs on the calling thread rather than
letting the worker fail on an unresolvable import. Classical runs still use the
worker.

## Engines

### `ai`

The network's output, with alpha handled separately (below). Best on photographic
texture — hair, foliage, skin, fabric — where its inventions are plausible.

It *is* inventing. A GAN produces detail that was not in the source, which is
the point and also the risk: it will confidently hallucinate serifs onto a
sans-serif letterform. For text, `mode: 'document'` on the classical engine is
usually the better answer.

### `hybrid`

The network's structural reconstruction with the **real** high-frequency content
of the source put back on top, then a local anti-ring clamp against the
network's own output so the re-injected layer cannot overshoot edges the
network already made hard.

Where the source had genuine texture, you see that texture rather than a
synthesised approximation. Where it had none, nothing is added. The detail
injection is deliberately lighter than in the classical engine — the network
has already produced high-frequency content, and stacking both over-textures
the result.

### `auto`

AI when a model is *already installed* and the device can run it; classical
otherwise. It never downloads on a user's behalf, and never selects AI for
`mode: 'pixel-art'`.

## How alpha is handled

Real-ESRGAN and every comparable super-resolution model is RGB-only. Feeding a
fourth channel to a three-channel graph is a shape error, not a degradation.

So alpha is carried separately: the original alpha channel is resized with
Lanczos-3 in premultiplied linear space and reapplied to the network's output.

There is one more step that matters. Fully transparent pixels usually carry
black, and the network will hallucinate a fringe from that. Before inference,
colour is flood-filled outwards from opaque pixels into transparent ones, and
anything the flood cannot reach is filled with the mean of the valid colours
rather than left black — a network's receptive field is much wider than a
handful of flood iterations.

The threshold for "transparent" is deliberately not zero. A canvas stores colour
premultiplied at 8 bits, so `getImageData` un-premultiplies, and at alpha 1/255
that divides by 1/255: the colour of a nearly-transparent pixel is numerically
worthless. Those pixels are refilled from their neighbours rather than trusted.

## Execution providers

The session tries WebGPU first where `navigator.gpu` exists, then falls back to
WASM. `result.runtime` reports which actually ran.

WASM threading needs cross-origin isolation. Without `COOP`/`COEP` headers the
runtime silently falls back to a single thread, so the library caps
`numThreads` at 1 in that case rather than letting it pretend. To get threads:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

## Tiling

The network runs on tiles of its preferred size (512 source pixels for the
built-in models) with a 16-pixel halo, and the results are combined with a
smoothstep feather normalised by an accumulated weight buffer.

Feathering rather than a hard cut, because a convolutional network's effective
receptive field is not a hard radius — unlike the classical chain, the AI path
cannot promise a tiled result identical to a whole-image one, so it blends
instead. Feathering is disabled on sides that touch the image border, where
there is no neighbour to blend with.

## Scale mismatch

The 4x model asked for 2x runs the network and then resamples down; asked for
8x it runs the network and resamples up. Running the network repeatedly would
compound its artefacts, so it runs once and a high-quality classical resize
covers the remainder.

For an exact match, install the model whose native scale you want:
`realesrgan-x2` for 2x, `realesrgan-x4` for 4x and 8x.

## Cost

The model is 67 MB, once. Inference is far slower than the classical engine —
see [PERFORMANCE.md](PERFORMANCE.md) for measured numbers — and much more so on
WASM than on WebGPU.

Guidance: the classical engine for anything interactive or large; AI for a
small image where quality dominates and the user has opted in.

## Failure modes

| Symptom | Cause | Response |
|---|---|---|
| `MODEL_NOT_INSTALLED` | Explicit `engine: 'ai'`, nothing downloaded | Download, or use `auto` |
| `RUNTIME_UNAVAILABLE` | `onnxruntime-web` would not load | Install it, or pass `onnxRuntimeLoader` |
| `MODEL_CORRUPTED` | Checksum mismatch | The cached copy is discarded; retry |
| `INFERENCE_FAILED` | Every execution provider failed | Fall back to `classical` |
| `STORAGE_FULL` | IndexedDB quota | Delete a model, or free storage |
| `STORAGE_UNAVAILABLE` | No IndexedDB | AI is unavailable; `auto` picks classical |

Everything except an explicit engine request degrades rather than fails.

## Bringing your own model

Any ONNX model with a single NCHW float input, a single NCHW float output, and
dynamic spatial dimensions will work. See [MODELS.md](MODELS.md).
