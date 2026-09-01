# Testing

Two suites, split by what they can honestly verify.

| Suite | Runner | Environment | Covers |
|---|---|---|---|
| Unit | Vitest | Node | The numeric core: kernels, filters, colour, alpha, tiling, memory, presets, errors, the model layer |
| Browser | Playwright | Real Chromium | Everything that needs a browser: decode, encode, Workers, WebGPU, IndexedDB, the AI runtime, the network |

```bash
npm run test          # unit
npm run build:demo    # required before the browser suite
npm run test:e2e      # browser
npm run benchmark     # measurements, not assertions
```

There is deliberately no jsdom layer in between. A canvas shim would test the
shim.

## Unit tests

Pure functions on `Float32Array`, so they run in Node with no environment at
all.

The fixtures in [`tests/fixtures/synthetic.ts`](../tests/fixtures/synthetic.ts)
are chosen because each has a property that can be asserted *exactly* — which
is what makes them worth more than a photograph. A solid colour must survive
resampling bit-for-bit. A gradient must stay monotonic. An edge at the centre
must stay at the centre. A checkerboard must not shift phase. Noise is a fixed
LCG rather than `Math.random`, so a failure is reproducible.

Metrics available to tests: MSE, MAE, PSNR, windowed SSIM, max absolute
difference, per-channel range.

Coverage by area:

- **Kernels** — peak, symmetry, support, interpolation property, partition of
  unity, weight-table normalisation at every input/output pair, the
  half-integer tie-break for `box`.
- **Resampling** — exact dimensions, solid-colour preservation across every
  kernel and factor, no sub-pixel shift, monotonicity, expected overshoot from
  ringing kernels and its absence from non-ringing ones, anti-aliasing on
  downscale, cache-independence.
- **Colour and alpha** — transfer-function round trip, LUT accuracy against the
  exact functions, premultiply round trip, the dark-fringe test (straight alpha
  fringes, premultiplied does not), colour bleed reaching past the first ring.
- **Filters** — Gaussian normalisation and symmetry, gradient operators
  measuring a unit step as 0.5, Scharr's angular-error advantage over Sobel,
  structure-tensor orientation on known angles, sharpening raising local
  contrast without exceeding its neighbourhood, detail layers being mean-zero,
  denoise moving a noisy image closer to its clean original while preserving
  edges better than a Gaussian of matched strength.
- **Tiling and memory** — exact coverage with no gaps or overlaps, halo
  geometry, feather weights summing above zero everywhere, budget estimation,
  tile-size selection, the addressable ceiling.
- **Pipeline** — geometry at every scale, output invariants, transparency, the
  seam guarantee, cancellation, progress monotonicity, and a
  downscale-then-upscale comparison against a plain resize.
- **Models** — registry validation (every rejection rule), scale matching,
  download progress, checksum verification, truncated-body detection, retry and
  backoff, abort, tensor conversion in both directions.

### The seam guarantee

Worth calling out because it is unusually strong: tiled output is
**bit-identical** to a one-tile pass. Not "close enough to hide" — identical,
asserted with `maxAbsDiff(...) === 0` across tile sizes 16, 24, 32 and 48, at 2x
and 4x, on hard-edge and text-like content.

That test found two real defects during development:

1. The noise estimate and the sharpener's edge normalisation were whole-image
   reductions, so each tile computed its own and the tile grid showed up in the
   output. Global statistics now travel in `EngineContext`, and the adaptive
   normalisation was replaced with a fixed reference.
2. A one-tile run used an unpadded fast path, so it clamped its filters in
   output space while a tiled run had source-clamped data there. The two
   disagreed at the image border by up to 15 of 255 levels. There is now one
   execution path.

## Browser tests

### `distribution.spec.ts`

The packaging promises. The script tag really installs a constructible global;
the bundle really has no module-system leakage (`require`, `exports`, `module`,
`process` are all absent); the ESM bundle really imports without a bundler; both
really produce a valid PNG with a correct signature.

One test specifically guards against the laziest possible fake: it counts
distinct luma values before and after and asserts the enlargement produced
intermediate tones, which neither a returned original nor a CSS scale can do.

### `pipeline.spec.ts`

All nine input types. Every scale. Every output format. Transparency in PNG and
flattening for JPEG. Format defaulting, including never writing a transparent
image as JPEG. Every mode, with pixel-art asserted to add no colours by set
comparison. Progress ordering and throttling. Cancellation mid-run. Tiling
equivalence through the public API, tile counters, and a 1600×1200 at 4x run
that exercises automatic tiling.

### `worker-gpu.spec.ts`

The core running inside a module Worker with no `document` at all — this is what
enforces the DOM-independence rule. Main-thread responsiveness measured by
sampling `requestAnimationFrame` gaps during a 4x run. Fallback when the worker
URL is wrong. Cancellation reaching into the worker.

For WebGPU: that availability is reported honestly (the claim must match a real
adapter request, in both directions), that GPU and CPU resampling agree within
float tolerance across four kernels, and that a buffer-limit overflow surfaces
as a typed error rather than a crash.

### `ai-models.spec.ts`

Runs against the real model, really downloaded. Catalogue contents including
licence and attribution. `MODEL_NOT_INSTALLED` with an actionable message. A
67 MB download with streaming progress, byte-exact size, and verified checksum.
Persistence across a real page reload. A second download served from cache with
zero network traffic. Real inference, asserted to differ substantially from the
classical result — a stub would match it or be uniform. Hybrid differing from
plain AI. Transparency. Cancellation. Offline operation with all external
requests aborted. Corrupted-model detection. Deletion. And the three network
privacy tests.

The block shares one browser context on purpose: Playwright gives each test a
fresh context, which means fresh IndexedDB, and a cache that is wiped between
tests cannot demonstrate that a model persists.

### `react.spec.ts`

Runs against a real Vite production build, not a dev server. Boot without
console errors, an upscale through the hook with the result rendered at the
right natural size, cancellation clearing state without reporting an error, and
a check that a classical-only run never fetches the ONNX runtime — which is the
tree-shaking claim, measured.

### `electron.spec.ts`

Drives `examples/electron/` and asserts the same ESM bundle runs unmodified in a
sandboxed renderer with no Node integration.

## What is not covered

Stated plainly, because a test matrix that quietly omits things is worse than
one that admits them.

**WebGPU was not executed.** Playwright's headless shell does not expose
`navigator.gpu`, and this environment cannot launch the full Chromium binary.
The GPU tests skip with that reason rather than passing vacuously. The code
path is written, type-checked, and covered by tests that will run wherever an
adapter exists — but it has not been run here, and the throughput numbers in
[PERFORMANCE.md](PERFORMANCE.md) are CPU numbers.

**Electron was not executed.** Electron is not a dependency (a ~150 MB download
for one file), and its binary extraction fails in this sandbox. The test skips
with instructions. Enable it with `npm i -D electron`.

**Firefox and WebKit were not executed.** Both projects are configured, and the
suite is written to work on all three, but only Chromium was installable here.

**No real photographs.** Every fixture is procedural, so the repository carries
no binary assets and the numbers reproduce anywhere. The trade-off is that
sensor noise, chroma subsampling artefacts and lens softness are approximated
rather than sampled.

**Visual inspection is not automated.** There is no perceptual-hash or
screenshot-diff gate. Quality is measured with PSNR, SSIM, MAE and MSE, and
those metrics systematically penalise sharpening — which is why
[PERFORMANCE.md](PERFORMANCE.md) reports the enhancement passes scoring *worse*
than the bare resample rather than hiding it.

## Determinism

The classical engine is fully deterministic: same input, same options, same
bytes out. Synthetic fixtures use a fixed LCG. The AI engine is deterministic
for a given execution provider, but WebGPU and WASM differ in float
accumulation order, so AI assertions are on tolerances rather than exact values.

## Adding a test

Unit tests go in `tests/unit/*.test.ts` and import from
`packages/image-upscaler/src/` directly — not from `dist/` — so they fail on a
source change without a rebuild.

Browser tests go in `tests/e2e/*.spec.ts` and use a harness page under
`tests/e2e/pages/`. They import from `dist/`, because what they are testing is
the built artefact.
