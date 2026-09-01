import { CHANNELS, type Surface } from './surface.js';

/**
 * Alpha handling.
 *
 * Filtering straight (non-premultiplied) RGBA pulls the colour of fully
 * transparent pixels into visible ones, which is where the classic dark or
 * white halo around cut-out PNGs comes from. Every resample and convolution in
 * this library therefore runs on premultiplied data, and un-premultiplies once
 * at the very end.
 */
export function premultiply(surface: Surface): Surface {
  if (surface.premultiplied) return surface;
  const d = surface.data;
  for (let i = 0; i < d.length; i += CHANNELS) {
    const a = d[i + 3];
    d[i] *= a;
    d[i + 1] *= a;
    d[i + 2] *= a;
  }
  surface.premultiplied = true;
  return surface;
}

export function unpremultiply(surface: Surface): Surface {
  if (!surface.premultiplied) return surface;
  const d = surface.data;
  for (let i = 0; i < d.length; i += CHANNELS) {
    const a = d[i + 3];
    if (a > 1e-6) {
      const inv = 1 / a;
      d[i] *= inv;
      d[i + 1] *= inv;
      d[i + 2] *= inv;
    } else {
      d[i] = 0;
      d[i + 1] = 0;
      d[i + 2] = 0;
    }
  }
  surface.premultiplied = false;
  return surface;
}

/** True when at least one pixel is not fully opaque. */
export function hasTransparency(surface: Surface): boolean {
  const d = surface.data;
  for (let i = 3; i < d.length; i += CHANNELS) {
    if (d[i] < 0.999) return true;
  }
  return false;
}

/**
 * Push colour from opaque pixels outwards into transparent ones ("colour
 * bleed"). Fully transparent pixels usually carry black or white RGB, and a
 * network that consumes straight RGB will happily hallucinate a fringe from
 * that. Running this first gives those pixels plausible neighbours.
 *
 * Operates on straight (non-premultiplied) RGBA and leaves alpha alone. The
 * premultiplied classical path does not need it - there, transparent pixels
 * contribute zero by construction.
 *
 * Two details that matter more than they look:
 *
 *  - The threshold is not zero. A canvas stores colour premultiplied at 8 bits,
 *    so `getImageData` un-premultiplies, and at alpha 1/255 that divides by
 *    1/255: the colour of a nearly-transparent pixel is numerically worthless.
 *    Those pixels are refilled from their neighbours rather than trusted.
 *  - Any pixel the flood cannot reach is filled with the mean of the valid
 *    colours instead of being left black. A convolutional network's receptive
 *    field is far wider than a handful of flood iterations, so leaving the far
 *    corners black is exactly the fringe this function exists to prevent.
 */
export function bleedEdges(surface: Surface, iterations = 4, threshold = 0.02): Surface {
  if (surface.premultiplied) {
    throw new Error('bleedEdges expects straight alpha; un-premultiply first');
  }
  const { width, height } = surface;
  const data = surface.data;

  // `valid` marks pixels that carry usable colour: sufficiently opaque ones to
  // begin with, plus every pixel filled by an earlier round. Without it the
  // bleed would never reach past the first ring, since filled pixels keep their
  // original alpha and would not qualify as donors.
  const valid = new Uint8Array(width * height);
  let frontier = 0;
  let meanR = 0;
  let meanG = 0;
  let meanB = 0;
  let validCount = 0;
  for (let p = 0, i = 0; p < valid.length; p++, i += CHANNELS) {
    if (data[i + 3] > threshold) {
      valid[p] = 1;
      meanR += data[i];
      meanG += data[i + 1];
      meanB += data[i + 2];
      validCount++;
    } else {
      frontier++;
    }
  }
  if (frontier === 0) return surface;
  if (validCount === 0) return surface;

  meanR /= validCount;
  meanG /= validCount;
  meanB /= validCount;

  let remaining = frontier;
  for (let iter = 0; iter < iterations && remaining > 0; iter++) {
    const next = new Uint8Array(valid);
    let filled = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        if (valid[p]) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= width || (dx === 0 && dy === 0)) continue;
            const q = ny * width + nx;
            if (!valid[q]) continue;
            const j = q * CHANNELS;
            r += data[j];
            g += data[j + 1];
            b += data[j + 2];
            n++;
          }
        }
        if (n > 0) {
          const i = p * CHANNELS;
          data[i] = r / n;
          data[i + 1] = g / n;
          data[i + 2] = b / n;
          // Alpha is untouched: only the colour is borrowed.
          next[p] = 1;
          filled++;
        }
      }
    }
    if (filled === 0) break;
    valid.set(next);
    remaining -= filled;
  }

  // Whatever the flood did not reach gets the average valid colour. Cheap, and
  // far better than the black it would otherwise keep.
  if (remaining > 0) {
    for (let p = 0, i = 0; p < valid.length; p++, i += CHANNELS) {
      if (valid[p]) continue;
      data[i] = meanR;
      data[i + 1] = meanG;
      data[i + 2] = meanB;
    }
  }

  return surface;
}
