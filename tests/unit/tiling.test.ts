import { describe, expect, it } from 'vitest';
import {
  blendWeight,
  planTiles,
  singleTile,
} from '../../packages/image-upscaler/src/memory/TileManager.js';
import {
  assertOutputSize,
  chooseTileSize,
  estimateMemoryBudget,
  estimateProcessingMemory,
  formatBytes,
  MAX_OUTPUT_PIXELS,
} from '../../packages/image-upscaler/src/memory/MemoryManager.js';
import {
  blitRegion,
  createSurface,
  extractRegion,
  surfaceBytes,
} from '../../packages/image-upscaler/src/image/surface.js';
import { UpscalerError } from '../../packages/image-upscaler/src/core/errors.js';
import { gradient, maxAbsDiff, textLike } from '../fixtures/synthetic.js';

describe('tile planning', () => {
  it('covers the source exactly once, with no gaps and no double-ownership', () => {
    for (const [w, h, size] of [
      [100, 100, 32],
      [64, 64, 64],
      [65, 33, 16],
      [7, 3, 4],
      [1000, 1, 256],
    ]) {
      const plan = planTiles(w, h, size, 8);
      const coverage = new Uint8Array(w * h);
      for (const tile of plan.tiles) {
        for (let y = tile.y; y < tile.y + tile.height; y++) {
          for (let x = tile.x; x < tile.x + tile.width; x++) {
            coverage[y * w + x]++;
          }
        }
      }
      for (let i = 0; i < coverage.length; i++) {
        expect(coverage[i], `${w}x${h}/${size} pixel ${i}`).toBe(1);
      }
    }
  });

  it('marks border tiles correctly', () => {
    const plan = planTiles(100, 100, 40, 8);
    expect(plan.columns).toBe(3);
    expect(plan.rows).toBe(3);

    const first = plan.tiles[0];
    expect([first.atLeft, first.atTop, first.atRight, first.atBottom]).toEqual([
      true,
      true,
      false,
      false,
    ]);
    const last = plan.tiles[plan.tiles.length - 1];
    expect([last.atLeft, last.atTop, last.atRight, last.atBottom]).toEqual([
      false,
      false,
      true,
      true,
    ]);
  });

  it('clips the trailing tile to the image rather than overrunning it', () => {
    const plan = planTiles(100, 70, 40, 8);
    const last = plan.tiles[plan.tiles.length - 1];
    expect(last.x + last.width).toBe(100);
    expect(last.y + last.height).toBe(70);
    expect(last.width).toBe(20);
    expect(last.height).toBe(30);
  });

  it('pads every tile by the overlap, letting the padding run off-image', () => {
    const plan = planTiles(64, 64, 32, 12);
    for (const tile of plan.tiles) {
      expect(tile.paddedWidth).toBe(tile.width + 24);
      expect(tile.paddedHeight).toBe(tile.height + 24);
      expect(tile.paddedX).toBe(tile.x - 12);
      expect(tile.offsetX).toBe(12);
    }
  });

  it('singleTile produces exactly one tile covering everything', () => {
    const plan = singleTile(123, 45);
    expect(plan.tiles).toHaveLength(1);
    expect(plan.overlap).toBe(0);
    const [tile] = plan.tiles;
    expect([tile.x, tile.y, tile.width, tile.height]).toEqual([0, 0, 123, 45]);
    expect(tile.atLeft && tile.atTop && tile.atRight && tile.atBottom).toBe(true);
  });

  it('gives a single tile the same halo as any other, when asked', () => {
    // The controller always passes the engine's overlap here, so that a
    // one-tile run and a many-tile run treat the image border identically.
    const plan = singleTile(64, 64, 16);
    const [tile] = plan.tiles;
    expect(plan.overlap).toBe(16);
    expect([tile.paddedX, tile.paddedY]).toEqual([-16, -16]);
    expect([tile.paddedWidth, tile.paddedHeight]).toEqual([96, 96]);
    // Still owns the whole image, and still borders it on all four sides.
    expect([tile.width, tile.height]).toEqual([64, 64]);
    expect(tile.atLeft && tile.atTop && tile.atRight && tile.atBottom).toBe(true);
  });
});

describe('region extraction and blitting', () => {
  it('extracts an in-bounds region byte for byte', () => {
    const src = gradient(32, 32);
    const region = extractRegion(src, 8, 8, 16, 16);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const si = ((y + 8) * 32 + (x + 8)) * 4;
        const di = (y * 16 + x) * 4;
        expect(region.data[di]).toBe(src.data[si]);
      }
    }
  });

  it('clamps to the edge when the region runs off-image', () => {
    // This is what makes a padded tile at the border behave the same as a
    // whole-image pass, which also clamps.
    const src = gradient(16, 16);
    const region = extractRegion(src, -4, -4, 8, 8);
    // Every pixel in the top-left quadrant of the region replicates (0, 0).
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        expect(region.data[(y * 8 + x) * 4]).toBe(src.data[0]);
      }
    }
  });

  it('round-trips through extract and blit', () => {
    const src = gradient(40, 24);
    const dst = createSurface(40, 24);
    const region = extractRegion(src, 5, 3, 20, 12);
    blitRegion(dst, region, 5, 3);
    for (let y = 3; y < 15; y++) {
      for (let x = 5; x < 25; x++) {
        const i = (y * 40 + x) * 4;
        expect(dst.data[i], `${x},${y}`).toBe(src.data[i]);
      }
    }
  });

  it('blit ignores destinations outside the target', () => {
    const dst = createSurface(8, 8);
    const patch = gradient(8, 8);
    // Half off each edge; must not throw and must not corrupt neighbours.
    expect(() => blitRegion(dst, patch, -4, -4)).not.toThrow();
    expect(() => blitRegion(dst, patch, 6, 6)).not.toThrow();
  });

  it('reassembles a tiled image identically to the original', () => {
    // The mechanical half of the seam guarantee: extract with halo, write back
    // interior only, and the pixels must be untouched.
    const src = textLike(97, 61);
    const dst = createSurface(97, 61);
    const plan = planTiles(97, 61, 16, 8);
    for (const tile of plan.tiles) {
      const padded = extractRegion(
        src,
        tile.paddedX,
        tile.paddedY,
        tile.paddedWidth,
        tile.paddedHeight,
      );
      blitRegion(dst, padded, tile.x, tile.y, tile.offsetX, tile.offsetY, tile.width, tile.height);
    }
    expect(maxAbsDiff(dst, src)).toBe(0);
  });
});

describe('feather weights', () => {
  it('are 1 in the interior', () => {
    const tile = { atLeft: false, atTop: false, atRight: false, atBottom: false };
    expect(blendWeight(32, 32, 64, 64, 8, tile)).toBe(1);
  });

  it('ramp to 0 at an interior edge', () => {
    const tile = { atLeft: false, atTop: false, atRight: false, atBottom: false };
    expect(blendWeight(0, 32, 64, 64, 8, tile)).toBe(0);
    expect(blendWeight(4, 32, 64, 64, 8, tile)).toBeGreaterThan(0);
    expect(blendWeight(4, 32, 64, 64, 8, tile)).toBeLessThan(1);
    expect(blendWeight(8, 32, 64, 64, 8, tile)).toBe(1);
  });

  it('stay at 1 against an image border, where there is no neighbour to blend', () => {
    const tile = { atLeft: true, atTop: true, atRight: false, atBottom: false };
    expect(blendWeight(0, 0, 64, 64, 8, tile)).toBe(1);
    // But still ramp on the sides that do have a neighbour.
    expect(blendWeight(63, 32, 64, 64, 8, tile)).toBe(0);
  });

  it('are 1 everywhere when there is no overlap', () => {
    const tile = { atLeft: false, atTop: false, atRight: false, atBottom: false };
    expect(blendWeight(0, 0, 64, 64, 0, tile)).toBe(1);
  });

  it('sum to a positive value for every pixel of a real plan', () => {
    // If they did not, the normalisation step would divide by zero and leave
    // black pixels along the seams.
    const plan = planTiles(80, 80, 32, 8);
    const scale = 2;
    const outW = 160;
    const outH = 160;
    const totals = new Float32Array(outW * outH);
    for (const tile of plan.tiles) {
      const tw = tile.paddedWidth * scale;
      const th = tile.paddedHeight * scale;
      const ox = tile.paddedX * scale;
      const oy = tile.paddedY * scale;
      for (let y = 0; y < th; y++) {
        const gy = oy + y;
        if (gy < 0 || gy >= outH) continue;
        for (let x = 0; x < tw; x++) {
          const gx = ox + x;
          if (gx < 0 || gx >= outW) continue;
          totals[gy * outW + gx] += blendWeight(x, y, tw, th, 8 * scale, tile);
        }
      }
    }
    for (let i = 0; i < totals.length; i++) {
      expect(totals[i], `pixel ${i}`).toBeGreaterThan(0.1);
    }
  });
});

describe('memory planning', () => {
  it('reports a budget and whether it came from a browser signal', () => {
    const budget = estimateMemoryBudget();
    expect(budget.budget).toBeGreaterThan(0);
    expect(typeof budget.reported).toBe('boolean');
    // In Node there is no navigator.deviceMemory, so it must not claim to know.
    expect(budget.reported).toBe(false);
  });

  it('scales the estimate with pixels and scale factor', () => {
    const small = estimateProcessingMemory(640, 480, 2, 'classical', 1e9);
    const large = estimateProcessingMemory(1920, 1080, 2, 'classical', 1e9);
    const bigScale = estimateProcessingMemory(640, 480, 8, 'classical', 1e9);
    expect(large.peakBytes).toBeGreaterThan(small.peakBytes);
    expect(bigScale.peakBytes).toBeGreaterThan(small.peakBytes * 4);
  });

  it('says a small job fits and a huge one does not', () => {
    expect(estimateProcessingMemory(320, 240, 2, 'classical', 512e6).fits).toBe(true);
    expect(estimateProcessingMemory(8000, 6000, 8, 'classical', 512e6).fits).toBe(false);
  });

  it('picks a tile size inside the requested bounds', () => {
    // 4000x3000 at 2x is a 24 MP output, which is 384 MiB as float RGBA. The
    // output surface itself is unavoidable, so the budget has to clear it
    // before there is anything left to tile with.
    const size = chooseTileSize(4000, 3000, 2, 'classical', {
      budget: 2e9,
      min: 64,
      max: 1024,
    });
    expect(size).toBeGreaterThanOrEqual(64);
    expect(size).toBeLessThanOrEqual(1024);
    expect(Number.isInteger(size)).toBe(true);
  });

  it('picks smaller tiles as the budget shrinks', () => {
    const roomy = chooseTileSize(4000, 3000, 2, 'classical', { budget: 4e9 });
    // The fixed cost here (result plus decoded source) is about 960 MiB, so a
    // 1.05 GB budget leaves only a sliver of scratch and forces small tiles.
    const tight = chooseTileSize(4000, 3000, 2, 'classical', { budget: 1.05e9 });
    expect(tight).toBeLessThan(roomy);
  });

  it('refuses when even the unavoidable output surface will not fit', () => {
    // Tiling reduces the *scratch* peak, not the size of the result, so when
    // the result alone busts the budget an honest OUT_OF_MEMORY is the only
    // correct answer. See docs/PERFORMANCE.md for the 16 bytes-per-output-pixel
    // figure this follows from.
    try {
      chooseTileSize(8000, 6000, 8, 'classical', { budget: 100e6 });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(UpscalerError);
      expect((error as UpscalerError).code).toBe('OUT_OF_MEMORY');
      expect((error as UpscalerError).message).toMatch(/smaller scale factor/);
    }
  });

  it('computes surface bytes as 4 float channels', () => {
    expect(surfaceBytes(100, 100)).toBe(100 * 100 * 4 * 4);
  });

  it('rejects output geometry beyond the addressable ceiling', () => {
    expect(() => assertOutputSize(16384, 16384)).not.toThrow();
    try {
      assertOutputSize(20000, 20000);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as UpscalerError).code).toBe('IMAGE_TOO_LARGE');
    }
    expect(MAX_OUTPUT_PIXELS).toBe(16384 * 16384);
  });

  it('formats byte counts readably', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KiB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MiB');
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.0 GiB');
  });
});
