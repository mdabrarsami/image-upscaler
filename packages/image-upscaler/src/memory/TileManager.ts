/**
 * Tile planning.
 *
 * Tiling exists for two reasons: memory (a 8000x6000 image at 4x is a 3 GiB
 * float surface) and responsiveness (a single 40-second synchronous pass is
 * indistinguishable from a hang).
 *
 * The hard part is seams. Every filter here has a support radius, so a tile
 * processed in isolation gets the wrong answer within that radius of its
 * border. The fix is to give each tile a halo of real neighbouring pixels,
 * process the padded tile, then write back only the interior. As long as the
 * halo is at least as wide as the widest filter support, the result is
 * bit-identical to a whole-image pass and there is nothing to blend.
 *
 * That holds at the outer border of the image too, but only because the
 * controller runs *every* job through this path - a small image is a one-tile
 * plan with a halo, not a special unpadded case. The distinction matters: a
 * halo is clamp-extended in source space and then upscaled, whereas an unpadded
 * pass clamps in output space, and those are different extensions. Keeping one
 * path removes the discrepancy instead of leaving a border where tiled and
 * untiled output quietly disagree. The test suite asserts bit-equality across
 * tile sizes from 16 to whole-image, at 2x and 4x.
 *
 * AI tiles are different: a network's effective receptive field is not a hard
 * radius, so their halo is wider and the write-back is feathered. See
 * `blendWeight`.
 */

export interface Tile {
  index: number;
  /** Interior rectangle in source coordinates - what this tile owns. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Padded rectangle in source coordinates - what gets processed. */
  paddedX: number;
  paddedY: number;
  paddedWidth: number;
  paddedHeight: number;
  /** Offset of the interior inside the padded tile. */
  offsetX: number;
  offsetY: number;
  /** True when this tile touches the corresponding image border. */
  atLeft: boolean;
  atTop: boolean;
  atRight: boolean;
  atBottom: boolean;
}

export interface TilePlan {
  tiles: Tile[];
  columns: number;
  rows: number;
  tileSize: number;
  overlap: number;
  sourceWidth: number;
  sourceHeight: number;
}

export function planTiles(
  sourceWidth: number,
  sourceHeight: number,
  tileSize: number,
  overlap: number,
): TilePlan {
  const size = Math.max(1, Math.floor(tileSize));
  const pad = Math.max(0, Math.floor(overlap));
  const columns = Math.ceil(sourceWidth / size);
  const rows = Math.ceil(sourceHeight / size);
  const tiles: Tile[] = [];

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      const x = col * size;
      const y = row * size;
      const width = Math.min(size, sourceWidth - x);
      const height = Math.min(size, sourceHeight - y);

      // The padded rectangle is allowed to run outside the image; the region
      // extractor clamps to the edge. See the note at the top of this file for
      // the small border discrepancy that follows from clamping in source
      // rather than output space.
      const paddedX = x - pad;
      const paddedY = y - pad;
      const paddedWidth = width + pad * 2;
      const paddedHeight = height + pad * 2;

      tiles.push({
        index: tiles.length,
        x,
        y,
        width,
        height,
        paddedX,
        paddedY,
        paddedWidth,
        paddedHeight,
        offsetX: pad,
        offsetY: pad,
        atLeft: col === 0,
        atTop: row === 0,
        atRight: col === columns - 1,
        atBottom: row === rows - 1,
      });
    }
  }

  return { tiles, columns, rows, tileSize: size, overlap: pad, sourceWidth, sourceHeight };
}

/**
 * A one-tile plan covering the whole image.
 *
 * It still gets a halo. The halo is what makes a border filter see
 * source-clamped data rather than output-clamped data, and a single tile has to
 * agree with a multi-tile run on exactly that.
 */
export function singleTile(width: number, height: number, overlap = 0): TilePlan {
  return planTiles(width, height, Math.max(width, height), overlap);
}

/**
 * Feathering weight for a pixel inside a tile's padded output, used by the AI
 * path where the halo cannot be trusted to be exact.
 *
 * Returns 1 in the interior and ramps to 0 across the overlap, except on sides
 * that touch the image border, where there is no neighbour to blend with and
 * the tile's own answer is the only one available.
 */
export function blendWeight(
  x: number,
  y: number,
  paddedWidth: number,
  paddedHeight: number,
  overlap: number,
  tile: Pick<Tile, 'atLeft' | 'atTop' | 'atRight' | 'atBottom'>,
): number {
  if (overlap <= 0) return 1;
  let w = 1;
  if (!tile.atLeft) w = Math.min(w, ramp(x, overlap));
  if (!tile.atTop) w = Math.min(w, ramp(y, overlap));
  if (!tile.atRight) w = Math.min(w, ramp(paddedWidth - 1 - x, overlap));
  if (!tile.atBottom) w = Math.min(w, ramp(paddedHeight - 1 - y, overlap));
  return w;
}

/** Smoothstep ramp from 0 at the tile edge to 1 at `overlap` pixels in. */
function ramp(distance: number, overlap: number): number {
  if (distance >= overlap) return 1;
  if (distance <= 0) return 0;
  const t = distance / overlap;
  return t * t * (3 - 2 * t);
}
