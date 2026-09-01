# Algorithms

What the classical engine does, in order, and why each step is where it is.

## The pipeline

```
source (sRGB, straight alpha)
  |
  1. bilateral denoise            at source resolution
  2. premultiply alpha            always
     [linearise]                  optional, off by default
  3. extract detail layer         at source resolution
  |
  4. resample                     Lanczos-3 (or Lanczos-4 for text)
  5. anti-ring                    clamp to the source neighbourhood
  6. edge-directed refinement     structure-tensor steered
  7. re-inject detail             the source's own high frequencies
  8. adaptive sharpen             edge-protected, halo-clamped
  |
  9. clamp, un-premultiply, [de-linearise]
  v
output (sRGB, straight alpha)
```

Above 2x the whole chain runs once per doubling: 4x is two passes, 8x is three.
Detail re-established at 2x survives the next resample, which a single jump to
8x cannot reproduce. It costs about a third more time (1 + ¼ + ¹⁄₁₆ … of the
final pixel count) and looks better.

## 1. Denoise, first

Enlarging noise and then smoothing it costs 4 to 64 times the work and destroys
more real detail than smoothing first. The denoiser is bilateral: a spatial
Gaussian multiplied by a range Gaussian on luma difference, so pixels that are
near in space *and* similar in brightness average together while edges stay put.

Two implementation notes worth having:

The range term is driven by luma rather than per-channel distance. Per-channel
range weights let one channel average while another does not, which separates
chroma on coloured edges.

The range Gaussian is a lookup table indexed by squared luma difference, not
`Math.exp` per tap. At radius 4 that is 81 exponentials per pixel, and it was
the single most expensive thing in the denoiser before the table.

The strength is scaled by a measured noise estimate — the median absolute
Laplacian response, converted to a standard deviation — so a clean studio shot
is not softened just because the mode preset asked for denoising. That estimate
is computed **once over the whole image** and shared by every tile; computed per
tile it would vary across the grid and denoise each tile differently.

## 2. Alpha, always premultiplied

Filtering straight RGBA averages the colour of fully transparent pixels into
visible ones. Transparent pixels usually carry black, so the result is a dark
ring around every cut-out. Premultiplying makes a transparent pixel contribute
zero to both colour and coverage, which is arithmetically what "not there"
should mean.

There is a corollary that is easy to miss. On premultiplied data a pixel is
`colour × alpha`, so a linear filter `L` gives `L(colour × alpha) = colour ×
L(alpha)` — the colour survives **only because every channel got the same
treatment**. A filter that sharpens RGB and leaves alpha alone breaks that
identity, and the un-premultiplied result is hue-shifted at every partially
transparent pixel.

So the sharpener computes one gain per pixel from the luma of its residual and
applies it to all four channels, and the detail injector computes one soft-clip
factor per pixel from the largest channel and applies that to all four. Both
were per-channel at first, and both produced a measurable fringe.

### Colour space

The textbook says linearise before resampling: averaging gamma-encoded values
is not averaging light. The benchmark says otherwise, consistently:

| Method | PSNR | SSIM |
|---|---|---|
| Lanczos-3, sRGB space | **25.49 dB** | **0.8488** |
| Lanczos-3, linear light | 23.48 dB | 0.8091 |
| canvas `drawImage`, high | 25.39 dB | 0.8397 |

(1024×768 at 2x; the same ordering holds at 512×512 and at 4x.)

Linear light costs 2 dB. The reason is that almost everything on the web was
authored, composited and antialiased *in sRGB* — the gradients, the text
antialiasing, the alpha blending were all done there. Reconstructing such an
image in the space it was created in is closer to the truth than reconstructing
it in the space light lives in.

So `workingSpace` defaults to `'srgb'`. `'linear'` is available and correct for
content that genuinely represents light — renders, HDR-derived images, anything
where a bright thin line against a dark ground must not lose energy.

Premultiplication is unaffected by this choice: it is about compositing, not
gamma, and it happens either way.

## 3 and 7. Detail extraction and reconstruction

Interpolation is a low-pass filter. The output is band-limited to the source's
Nyquist frequency no matter how good the kernel is, and no amount of cleverness
recovers frequencies that are not there.

What *is* possible is putting the source's own high-frequency band back at the
right amplitude in the right places. The layer is extracted before anything
band-limits it (`src − blur(src)`), carried up, and re-injected. Because it is
mean-zero, adding it changes local contrast without shifting local brightness.

This is redistribution, not invention. Nothing is hallucinated — that is what
the AI engine is for, and why it is a separate engine.

The layer is scaled up with Mitchell rather than Lanczos, deliberately: a
ringing kernel applied to a high-pass signal produces ringing about the
ringing, which is exactly the artefact this pass exists to avoid.

## 4. Resampling

Two-pass separable filtering. Separable means O(w·h·taps) per axis instead of
O(w·h·taps²), which for Lanczos-3 at 4x is the difference between usable and
not.

Weights are precomputed into a flat table with a uniform stride, so the inner
loop does no allocation and no per-output-pixel setup. The table depends only
on (kernel, inputSize, outputSize), so it caches perfectly across tiles.

The axis with the smaller intermediate runs first: it makes the second pass
cheaper and the temporary buffer smaller.

### Kernels

| Kernel | Support | Character |
|---|---|---|
| `box` | 0.5 | Nearest neighbour. Pixel art. |
| `bilinear` | 1 | No overshoot possible. Soft. |
| `bicubic` (Catmull-Rom) | 2 | Interpolating. Mild ringing. |
| `mitchell` (B=C=⅓) | 2 | Approximating. Lobe ~¼ the depth of Lanczos-3. |
| `lanczos2/3/4` | 2/3/4 | Windowed sinc. Sharpest, and rings the most. |

Measured lobe depths, since "rings more" deserves a number: Lanczos-3 reaches
−0.147 at x ≈ 1.37; Mitchell reaches −0.036 at x ≈ 1.43.

Every kernel is normalised per output pixel, because windowed-sinc kernels do
not sum to 1 at arbitrary sub-pixel phases. Without it, flat regions shift
brightness and gradients band — the single most important invariant in the
resampler, and the one with the most tests.

`box` is half-open (`|x| < 0.5`, not `≤`). An inclusive bound makes both taps
fire at half-integer phase, and the normaliser would then average them — which
is bilinear, exactly what someone reaching for nearest neighbour is avoiding.
At half-integer phase no tap qualifies, so the normaliser breaks the tie by
selecting the centre tap.

When downscaling, the kernel is stretched by the scale ratio so it acts as a
proper low-pass filter instead of point-sampling and aliasing.

## 5. Anti-ringing

Windowed-sinc kernels have negative lobes, so near a hard edge they overshoot —
the light and dark bands that show up as halos on text and line art.

The fix is a clamp: for every output pixel, find the min and max of the source
pixels that contributed to it, and clamp the result into that interval. A
resampled pixel has no business being brighter or darker than every input it
was built from.

`amount` blends between the raw and clamped result, because a hard clamp at
full strength very slightly softens diagonal edges. `document` mode uses 1.0;
photographic modes use 0.7 to 0.85.

The min/max is computed once over the whole source with a separable pass and
then sampled per output pixel. Min and max over a square are separable exactly
as a Gaussian is:

```
min over the square = min over x of (min over y)
```

so two 1-D passes replace an O((2r+1)²) window scan. Computing it at source
resolution rather than per output pixel is the larger win — at 4x the source
has one sixteenth the pixels. Together these took the pass from 158 ms to
46 ms on the profiling case.

## 6. Edge-directed refinement

A separable kernel filters along x and y and knows nothing about orientation,
so a 30° edge comes out of any linear resize with visible stair steps.

For each pixel a structure tensor gives an edge tangent and an anisotropy
score. Where anisotropy is high the pixel is replaced by a short 1-D average
taken *along* the tangent — which removes the staircase without crossing the
edge — plus a mild 1-D unsharp *across* the normal to restore the acuity the
tangential average costs.

Where anisotropy is low (texture, noise, flat areas) the blend weight falls to
zero and the base pixel survives untouched. That threshold is the whole
difference between this and a naive edge-directed filter: steering texture
along a meaningless "dominant direction" is what produces the waxy look.

The refined value is clamped to the range of the samples it was built from. The
tangential average is inside that range by construction; the cross-edge
sharpening term is not, and on an axis-aligned edge it deepens the ringing the
previous pass just removed. Straightening an edge must never create a new
extreme.

The tensor uses Scharr rather than Sobel. Scharr's coefficients were derived to
minimise error in the gradient *direction*, which is precisely the quantity
being steered on — a biased direction sends the tangential average across the
edge instead of along it. (Sobel is not worse at gradient *magnitude*; the
tests measure the angular error specifically, because that is the property in
use here.)

This is DDT/warp-style refinement, not NEDI: it does not re-derive the
interpolation weights from local covariance. It is far cheaper and, on top of
Lanczos-3, visually competitive.

## 8. Adaptive sharpening

Plain unsharp masking amplifies everything, including sensor noise in flat
areas and the already-steep sides of hard edges — which is where halos come
from. Three mechanisms constrain it:

**A soft knee.** Residuals below a threshold are suppressed and fade in to full
gain at twice the threshold, so grain is not boosted. The knee is computed from
the luma of the residual, once per pixel, and applied to all four channels —
both because a per-channel threshold shifts hue on low-contrast coloured
detail, and because of the premultiplied-alpha identity above.

**Edge protection.** Gain rolls off as the square of gradient magnitude,
normalised against a fixed reference (0.25 per pixel in linear terms). Fixed,
not adaptive: a percentile of the image's own gradients is a global statistic,
and a tile would compute a different one from the whole frame. That is precisely
how tiled output grows visible seams, and it is what the earlier implementation
did.

**A halo clamp.** Each sharpened pixel is clamped to the 3×3 min/max of the
*unsharpened* image and blended back. A sharpened pixel may sit at the extreme
of its neighbourhood but not beyond it. At full strength this makes overshoot
mathematically impossible.

## Tiling

Every filter has a support radius, so a tile processed in isolation gets the
wrong answer within that radius of its border. Each tile is given a halo of
real neighbouring pixels, processed, and written back interior-only.

The classical chain's widest support is Lanczos-4 (4 source pixels), the
anti-ring window (2), and the detail Gaussian (about 3σ). A 16-pixel halo
covers all of it with room to spare, and the result is **bit-identical** to a
one-tile pass — not close, identical. The suite asserts that across tile sizes
from 16 to whole-image at 2x and 4x.

The AI path cannot make that guarantee, because a convolutional network's
effective receptive field is not a hard radius. It uses a wider halo and a
smoothstep-feathered accumulate normalised by a weight buffer, with the
feathering disabled on sides that touch the image border, where there is no
neighbour to blend with.

## Pixel art

Every filter in this document is a defect on pixel art. `mode: 'pixel-art'`
bypasses the whole chain and magnifies by pixel replication: no colour-space
round trip (nearest neighbour never averages, so gamma cannot matter), no
denoise, no sharpen, no anti-ringing. The output palette is exactly the input
palette, which the tests verify by set comparison.

`auto` never selects the AI engine in this mode. A GAN will happily smear
sprite art into mush.

## What is not implemented

Honest omissions:

- **NEDI / iterative curvature methods.** Substantially more expensive for a
  gain that the detail-reconstruction pass largely covers.
- **Multi-frame or burst super-resolution.** Out of scope; the API takes one
  image.
- **A WASM SIMD kernel for the CPU path.** Benchmarked as unpromising: the hot
  loops are memory-bound rather than arithmetic-bound, and JS typed arrays are
  already close to memcpy speed on them. The GPU path is where the headroom is.
- **Chroma subsampling awareness.** JPEG chroma is upsampled by the browser
  decoder before the library sees it.
