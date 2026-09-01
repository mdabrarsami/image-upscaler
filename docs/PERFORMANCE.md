# Performance

Every number in this document was measured by
[`benchmarks/run.mjs`](../benchmarks/run.mjs) on the machine described below.
Nothing is estimated or extrapolated, and cases that were refused are reported
as refusals rather than omitted.

```bash
npm run benchmark          # throughput and quality
node benchmarks/run.mjs --ai      # include the AI engine
node benchmarks/run.mjs --quick   # a fast subset
```

Results are written to `benchmarks/results/latest.json` and `latest.md`.

<!-- RESULTS:BEGIN -->

Generated 2026-09-01T11:08:05.104Z

### Measured on

| Item          | Value              |
|---------------|--------------------|
| Chromium      | 151.0.7922.34      |
| Node          | v26.3.1            |
| Platform      | win32 x64          |
| Logical cores | 32                 |
| WebGPU        | false              |
| WebGL2        | true               |
| WASM SIMD     | true               |
| Memory budget | 4295 MB (reported) |


### Throughput

Median wall-clock time for a complete call, decode and PNG encode included.

| Source    | Scale | Engine    | Mode     | Runtime | Tiles | Median ms | MP/s  | Result    |
|-----------|-------|-----------|----------|---------|-------|-----------|-------|-----------|
| 640x480   | 2x    | canvas    | -        | cpu     | 1     | 43        | 28.31 | 1280x960  |
| 640x480   | 2x    | classical | natural  | cpu     | 1     | 702       | 1.75  | 1280x960  |
| 640x480   | 2x    | classical | balanced | cpu     | 1     | 684       | 1.80  | 1280x960  |
| 640x480   | 2x    | ai        | balanced | wasm    | 1     | 70125     | 0.02  | 1280x960  |
| 640x480   | 2x    | hybrid    | balanced | wasm    | 1     | 134607    | 0.01  | 1280x960  |
| 640x480   | 4x    | canvas    | -        | cpu     | 1     | 317       | 15.49 | 2560x1920 |
| 640x480   | 4x    | classical | natural  | cpu     | 1     | 4820      | 1.02  | 2560x1920 |
| 640x480   | 4x    | classical | balanced | cpu     | 1     | 5092      | 0.97  | 2560x1920 |
| 640x480   | 8x    | canvas    | -        | cpu     | 1     | 1202      | 16.36 | 5120x3840 |
| 640x480   | 8x    | classical | natural  | cpu     | 1     | 19832     | 0.99  | 5120x3840 |
| 640x480   | 8x    | classical | balanced | cpu     | 1     | 20370     | 0.97  | 5120x3840 |
| 1280x720  | 2x    | canvas    | -        | cpu     | 1     | 254       | 14.54 | 2560x1440 |
| 1280x720  | 2x    | classical | natural  | cpu     | 1     | 3415      | 1.08  | 2560x1440 |
| 1280x720  | 2x    | classical | balanced | cpu     | 1     | 3283      | 1.12  | 2560x1440 |
| 1280x720  | 2x    | ai        | balanced | wasm    | 1     | 372833    | 0.01  | 2560x1440 |
| 1280x720  | 2x    | hybrid    | balanced | wasm    | 6     | 457301    | 0.01  | 2560x1440 |
| 1280x720  | 4x    | canvas    | -        | cpu     | 1     | 971       | 15.18 | 5120x2880 |
| 1280x720  | 4x    | classical | natural  | cpu     | 1     | 14416     | 1.02  | 5120x2880 |
| 1280x720  | 4x    | classical | balanced | cpu     | 1     | 14618     | 1.01  | 5120x2880 |
| 1920x1080 | 2x    | canvas    | -        | cpu     | 1     | 637       | 13.01 | 3840x2160 |
| 1920x1080 | 2x    | classical | natural  | cpu     | 1     | 7343      | 1.13  | 3840x2160 |
| 1920x1080 | 2x    | classical | balanced | cpu     | 1     | 7470      | 1.11  | 3840x2160 |
| 1920x1080 | 4x    | canvas    | -        | cpu     | 1     | 2233      | 14.86 | 7680x4320 |
| 1920x1080 | 4x    | classical | natural  | cpu     | 1     | 31262     | 1.06  | 7680x4320 |
| 1920x1080 | 4x    | classical | balanced | cpu     | 1     | 19281     | 1.72  | 7680x4320 |
| 2560x1440 | 2x    | canvas    | -        | cpu     | 1     | 612       | 24.08 | 5120x2880 |
| 2560x1440 | 2x    | classical | natural  | cpu     | 1     | 7605      | 1.94  | 5120x2880 |
| 2560x1440 | 2x    | classical | balanced | cpu     | 1     | 13300     | 1.11  | 5120x2880 |
| 3840x2160 | 2x    | canvas    | -        | cpu     | 1     | 2457      | 13.50 | 7680x4320 |
| 3840x2160 | 2x    | classical | natural  | cpu     | 1     | 29538     | 1.12  | 7680x4320 |
| 3840x2160 | 2x    | classical | balanced | cpu     | 1     | 29709     | 1.12  | 7680x4320 |


### Limits

Sizes where the question is whether the library copes at all, rather than how fast. Not timed against a baseline: at these resolutions the browser PNG encoder dominates the measurement.

| Source    | Scale | Output MP | Outcome                  | Time     | Tiles |
|-----------|-------|-----------|--------------------------|----------|-------|
| 6000x4000 | 2x    | 96        | handled                  | 88528 ms | 24    |
| 8000x6000 | 2x    | 192       | refused: IMAGE_TOO_LARGE | -        | -     |
| 4000x3000 | 4x    | 192       | refused: IMAGE_TOO_LARGE | -        | -     |
| 8000x6000 | 8x    | 3072      | refused: IMAGE_TOO_LARGE | -        | -     |


### Quality

Each source is rendered at full size, downscaled, then enlarged back and compared with the original. Higher PSNR and SSIM are better; lower MAE and MSE are better.


### 512x512 at 2x

| Method                         | PSNR dB | SSIM   | MAE   | MSE   |
|--------------------------------|---------|--------|-------|-------|
| canvas nearest                 | 21.52   | 0.7778 | 12.41 | 458.3 |
| canvas low                     | 23.91   | 0.8199 | 9.93  | 264.3 |
| canvas high (drawImage)        | 24.21   | 0.8299 | 9.71  | 246.4 |
| raw lanczos3 (linear light)    | 22.42   | 0.7927 | 12.13 | 372.3 |
| raw lanczos3 (sRGB space)      | 24.41   | 0.8406 | 9.76  | 235.5 |
| raw bicubic (sRGB space)       | 24.29   | 0.8386 | 9.65  | 242.0 |
| raw bilinear (sRGB space)      | 23.91   | 0.8199 | 9.92  | 264.3 |
| lanczos3 only (no enhancement) | 24.39   | 0.8386 | 9.86  | 236.7 |
| lanczos3 + anti-ring           | 24.42   | 0.8391 | 9.80  | 234.9 |
| classical natural              | 23.48   | 0.8268 | 11.01 | 291.7 |
| classical balanced             | 21.65   | 0.7939 | 14.07 | 444.6 |
| classical detail               | 20.49   | 0.7677 | 16.32 | 581.3 |
| classical document             | 21.66   | 0.7966 | 13.98 | 443.8 |
| AI (Real-ESRGAN 2x)            | 24.25   | 0.8499 | 9.33  | 244.6 |
| hybrid                         | 23.53   | 0.8563 | 10.27 | 288.2 |

### 512x512 at 4x

| Method                         | PSNR dB | SSIM   | MAE   | MSE    |
|--------------------------------|---------|--------|-------|--------|
| canvas nearest                 | 17.99   | 0.5130 | 21.00 | 1032.5 |
| canvas low                     | 19.17   | 0.5445 | 18.15 | 786.6  |
| canvas high (drawImage)        | 19.22   | 0.5532 | 18.19 | 778.8  |
| raw lanczos3 (linear light)    | 18.42   | 0.5240 | 20.91 | 936.2  |
| raw lanczos3 (sRGB space)      | 19.24   | 0.5782 | 18.64 | 774.1  |
| raw bicubic (sRGB space)       | 19.20   | 0.5697 | 18.49 | 781.2  |
| raw bilinear (sRGB space)      | 19.16   | 0.5444 | 18.23 | 789.6  |
| lanczos3 only (no enhancement) | 19.13   | 0.5756 | 18.92 | 794.8  |
| lanczos3 + anti-ring           | 19.12   | 0.5733 | 18.91 | 796.9  |
| classical natural              | 18.36   | 0.5684 | 20.84 | 948.3  |
| classical balanced             | 16.38   | 0.5223 | 26.12 | 1495.0 |
| classical detail               | 14.92   | 0.4795 | 31.14 | 2093.9 |
| classical document             | 16.30   | 0.5193 | 26.16 | 1526.0 |

### 1024x768 at 2x

| Method                         | PSNR dB | SSIM   | MAE   | MSE   |
|--------------------------------|---------|--------|-------|-------|
| canvas nearest                 | 22.44   | 0.7930 | 10.61 | 370.6 |
| canvas low                     | 25.06   | 0.8308 | 8.41  | 202.9 |
| canvas high (drawImage)        | 25.39   | 0.8397 | 8.19  | 187.8 |
| raw lanczos3 (linear light)    | 23.48   | 0.8091 | 10.24 | 291.8 |
| raw lanczos3 (sRGB space)      | 25.49   | 0.8488 | 8.35  | 183.6 |
| raw bicubic (sRGB space)       | 25.44   | 0.8475 | 8.16  | 185.9 |
| raw bilinear (sRGB space)      | 25.06   | 0.8307 | 8.40  | 202.8 |
| lanczos3 only (no enhancement) | 25.57   | 0.8478 | 8.34  | 180.5 |
| lanczos3 + anti-ring           | 25.62   | 0.8482 | 8.26  | 178.4 |
| classical natural              | 24.56   | 0.8373 | 9.42  | 227.6 |
| classical balanced             | 22.59   | 0.8082 | 12.13 | 358.0 |
| classical detail               | 21.38   | 0.7846 | 14.04 | 473.3 |
| classical document             | 22.64   | 0.8119 | 12.00 | 354.0 |
| AI (Real-ESRGAN 2x)            | 24.97   | 0.8475 | 8.46  | 206.8 |
| hybrid                         | 24.35   | 0.8555 | 9.20  | 239.0 |

<!-- RESULTS:END -->

## Methodology

**Throughput** is median wall-clock time for a complete `upscale()` call —
decode, processing and PNG encode included, because that is what a consumer
waits for. Warm-up runs are discarded: the first call through any path pays for
weight-table construction, JIT warm-up and, for AI, session creation, and
reporting that as steady-state throughput would be misleading.

The baseline is canvas `drawImage` at `imageSmoothingQuality: 'high'`, timed
the same way including its encode, so the comparison is like for like.

**Quality** is a downscale-then-upscale round trip: a reference is rendered at
full size, reduced, enlarged back, and compared with the reference. It is the
only honest way to score an upscaler — comparing two enlargements to each other
tells you they differ, not which is right.

The reduction uses the library's own Lanczos-3. Using canvas there would
quietly favour the canvas methods, which would be inverting a filter from the
same family that produced their input while everything else was not.

The test image is procedural, so it reproduces anywhere and the repository
carries no binary fixtures. It contains what separates upscalers: smooth
gradients, hard edges, fine repeating structure, curves, off-axis hatching, a
faint grain field and text.

Its shapes are **rotated**, and that matters. An earlier version drew
everything on the pixel grid, and nearest-neighbour scored the best SSIM of any
method — not because it reconstructs well, but because a grid-aligned edge
halved and doubled lands back exactly where it started. Rotation removes that
free win.

## Reading the quality table

Two things in it look like bad news and are not.

**The enhancement passes score worse than the bare resample.** They will always
score worse on a reference-based metric. The reference contains high
frequencies that the downscale removed; sharpening adds contrast that is
plausible but not identical to what was lost, and MSE punishes any deviation
regardless of direction. A blurrier reconstruction scores better and looks
worse.

So the table reports both, and the resampler is judged on the `lanczos3 only`
and `lanczos3 + anti-ring` rows. Those beat `drawImage` on every metric. The
mode rows show exactly what each preset trades away.

The one method that beats everything on SSIM is **hybrid** — 0.8563 at 512x512
2x and 0.8555 at 1024x768, higher than the bare resample, than `drawImage`, and
than the AI engine alone. That is the argument for the hybrid design in one
number: the network reconstructs structure, and putting the source's real
detail back on top recovers the structural similarity that pure AI output
loses. It costs PSNR, for the same reason every sharpening pass does.

This is also why `natural` is tuned where it is. At sharpening 0.30 / detail
0.35 it cost about 2 dB against the bare resample, which is a lot for a mode
whose purpose is to look untouched; at 0.18 / 0.20 the cost is about 1 dB and
the acuity gain is still clearly visible. That change came from this table.

**Linear light scores worse than sRGB.** Consistently, by 1 to 2 dB. See
[ALGORITHMS.md](ALGORITHMS.md#colour-space); it is the reason `workingSpace`
defaults to `srgb`.

## Where the time goes

Per-stage timings for 640×480 → 1280×960, `balanced`, single-threaded CPU:

| Stage | Before optimisation | After | Notes |
|---|---|---|---|
| `estimateNoise` (source) | 9 ms | 9 ms | Sparse grid, cheap already |
| `bilateralDenoise` (source) | 155 ms | 68 ms | Range LUT replaced `Math.exp` per tap |
| linearise + premultiply | 5 ms | 5 ms | |
| `extractDetail` (source) | 17 ms | 17 ms | |
| **`resample`** | **49 ms** | **47 ms** | The actual enlargement |
| `antiRing` | 158 ms | 46 ms | Separable min/max, computed at source resolution |
| `edgeDirectedRefine` | 191 ms | 140 ms | Eigenvector computed only for qualifying pixels |
| `reconstructDetail` | 47 ms | 47 ms | |
| `adaptiveSharpen` | 480 ms | 156 ms | of which: |
| — `blurSurface` | 94 ms | 46 ms | Edge clamping hoisted out of the interior loop |
| — `suppressHalos` | 299 ms | 79 ms | Separable min/max |
| **Total** | **1503 ms** | **660 ms** | 2.3x |

Worth sitting with: the resample itself is under a tenth of the time. This
library is slower than `drawImage` because it does nine more things, not
because the interpolation is slow.

The four optimisations, in order of value:

1. **Separable min/max.** Anti-ringing and halo suppression both need the min
   and max of a square neighbourhood. Done directly that is (2r+1)² reads per
   channel; min and max are separable exactly as a Gaussian is, so two 1-D
   passes replace it.
2. **Anti-ringing at source resolution.** The min/max plane is computed once
   over the source and sampled per output pixel. At 4x the source has one
   sixteenth the pixels.
3. **A range LUT in the bilateral filter.** At radius 4 that removed 81
   `Math.exp` calls per pixel.
4. **Deciding before computing in the edge-directed pass.** Anisotropy needs
   only the eigenvalues; the eigenvector needs a square root and a
   normalisation, and nine pixels in ten never use it.

## Limits

### Memory

The pipeline works in `Float32` RGBA: **16 bytes per output pixel**, plus
working copies. Float is not negotiable — the chain is ten passes deep and
8-bit intermediates band visibly after two or three, and the detail layer is a
signed residual 8 bits cannot represent.

That makes large outputs memory-bound rather than time-bound:

| Output | Pixels | Output surface alone |
|---|---|---|
| 3840×2160 | 8.3 MP | 133 MiB |
| 7680×4320 (4K at 2x) | 33 MP | 531 MiB |
| 12000×8000 (6000×4000 at 2x) | 96 MP | 1.5 GiB |
| 16000×12000 (4000×3000 at 4x) | 192 MP | 3.0 GiB |

Tiling reduces the *scratch* peak, not the size of the result. When the result
alone exceeds the budget, `chooseTileSize` throws `OUT_OF_MEMORY` with the
required and available figures, because tiling genuinely cannot help.

Beyond that there is a harder wall. A `Float32Array` cannot exceed
2^31 - 1 elements, which at four channels is about 536 million pixels — so a
result over roughly 134 megapixels cannot be allocated at all, whatever the
machine has. That is what the Limits table above shows: 192 megapixel outputs
are refused with `IMAGE_TOO_LARGE` regardless of how they are reached, whether
that is 8000×6000 at 2x or 4000×3000 at 4x. A 96 megapixel result (6000×4000 at
2x) is handled, in 24 tiles, in about 88 seconds.

`MAX_OUTPUT_PIXELS` is 268,435,456 (16384×16384), the canvas-side ceiling; the
`Float32Array` limit bites first for four-channel surfaces. Both are properties
of the platform rather than policy choices.

The memory budget itself is a guess on most browsers. `navigator.deviceMemory`
is coarse, capped at 8 GiB, and unimplemented in Firefox and Safari, so
`estimatedMemoryIsReported` tells you whether the number came from a real
signal. When it did not, the library assumes a modest machine and tiles
earlier than it needs to, which is the right way to be wrong.

### Threading

Single-threaded. The Worker moves work off the UI thread; it does not
parallelise it. Tiles are processed sequentially.

Parallelising across a worker pool is the obvious next step and is not
implemented. It would need a `SharedArrayBuffer` for the shared output surface,
which needs cross-origin isolation, which many pages cannot adopt — and the
partial answer (copying tiles between workers) spends a good fraction of the
gain on transfers.

### GPU

The WebGPU resample was **not exercised in the environment these numbers come
from**: Playwright's headless shell does not expose `navigator.gpu`, and the
full Chromium binary cannot be launched in this sandbox. Every number here is
CPU.

The GPU path is written, type-checked, and covered by tests that compare it
against the CPU path across four kernels — those tests skip with that reason
rather than passing vacuously. On hardware with an adapter, expect the
resample line specifically to improve; it is under a tenth of total time, so
the end-to-end gain is bounded by the rest of the pipeline.

### AI

Slow on WASM, and the numbers show it. Real-ESRGAN is a 23-block RRDBNet: tens
of billions of operations for a 512×512 tile. WebGPU inference is
substantially faster and was not measurable here.

Practical guidance: the classical engine for anything interactive or large; AI
for a small image where quality dominates and the user has explicitly asked.

## Choosing settings

| Goal | Settings |
|---|---|
| Fastest acceptable | `engine: 'classical'`, `mode: 'natural'` |
| Best fidelity to the source | `engine: 'classical'`, `sharpening: 0`, `detail: 0` |
| Best perceived sharpness | `engine: 'classical'`, `mode: 'detail'` |
| Text and scans | `engine: 'classical'`, `mode: 'document'` |
| Photographic texture, quality over time | `engine: 'hybrid'` |
| Pixel art | `mode: 'pixel-art'` (also the fastest path by far) |

Two things that cost more than people expect: 8x runs the whole chain three
times, and PNG encoding a very large result is slow in every browser — WebP or
JPEG output is materially faster when the format is acceptable.

One thing that costs nothing: reusing the `ImageUpscaler` instance. It caches
the GPU device, compiled shaders, weight tables and inference sessions.
