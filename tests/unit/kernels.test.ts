import { describe, expect, it } from 'vitest';
import {
  bicubic,
  bilinear,
  box,
  buildWeightTable,
  cubicBC,
  getKernel,
  lanczos2,
  lanczos3,
  lanczos4,
  mitchell,
} from '../../packages/image-upscaler/src/algorithms/kernels.js';

const ALL = [box, bilinear, bicubic, mitchell, lanczos2, lanczos3, lanczos4];

function sample(kernel: (x: number) => number, from: number, to: number, step = 0.01): number[] {
  const out: number[] = [];
  for (let x = from; x <= to; x += step) out.push(kernel(x));
  return out;
}

describe('reconstruction kernels', () => {
  it('all peak at zero', () => {
    for (const kernel of ALL) {
      const peak = kernel(0);
      for (let x = 0.05; x <= kernel.support; x += 0.05) {
        expect(kernel(x), `${kernel.name} at ${x}`).toBeLessThanOrEqual(peak + 1e-12);
      }
    }
  });

  it('the interpolating kernels have unit gain at zero', () => {
    // Mitchell is excluded on purpose: with B != 0 it is an approximating
    // filter, normalised so its integer samples sum to one rather than so its
    // peak reaches one. Its peak is 8/9.
    for (const kernel of [box, bilinear, bicubic, lanczos2, lanczos3, lanczos4]) {
      expect(kernel(0), kernel.name).toBeCloseTo(1, 10);
    }
    expect(mitchell(0)).toBeCloseTo(8 / 9, 12);
  });

  it('the polynomial kernels form a partition of unity', () => {
    // Sampling one of these at any sub-pixel phase and summing across the
    // integer grid must give exactly 1, or flat regions change brightness.
    // `box` is excluded: it is discontinuous at +/-0.5, so at exactly
    // half-integer phase no tap is inside the window and the sum is 0. That is
    // inherent to nearest neighbour, not a defect - see the weight-table test
    // below for how the resampler resolves it.
    for (const kernel of [bilinear, bicubic, mitchell]) {
      for (const phase of [0, 0.13, 0.25, 0.5, 0.77]) {
        let sum = 0;
        for (let n = -4; n <= 4; n++) sum += kernel(phase + n);
        expect(sum, `${kernel.name} at phase ${phase}`).toBeCloseTo(1, 10);
      }
    }
  });

  it('all vanish at and beyond their stated support', () => {
    for (const kernel of ALL) {
      expect(kernel(kernel.support), kernel.name).toBeCloseTo(0, 10);
      expect(kernel(kernel.support + 0.5), kernel.name).toBe(0);
      expect(kernel(-kernel.support - 1), kernel.name).toBe(0);
    }
  });

  it('all are symmetric', () => {
    for (const kernel of ALL) {
      for (const x of [0.1, 0.37, 0.5, 1.2, 1.9, 2.6]) {
        expect(kernel(x), `${kernel.name} at ${x}`).toBeCloseTo(kernel(-x), 12);
      }
    }
  });

  it('lanczos crosses zero at every non-zero integer inside its window', () => {
    // The defining property of a sinc-derived kernel: it interpolates, so a
    // sample sitting exactly on a source pixel reproduces that pixel exactly.
    for (const kernel of [lanczos2, lanczos3, lanczos4]) {
      for (let n = 1; n < kernel.support; n++) {
        expect(kernel(n), `${kernel.name} at ${n}`).toBeCloseTo(0, 10);
      }
    }
  });

  it('bicubic (Catmull-Rom) also interpolates', () => {
    expect(bicubic(1)).toBeCloseTo(0, 12);
    expect(bicubic(2)).toBeCloseTo(0, 12);
  });

  it('mitchell does not interpolate, and rings far less than lanczos', () => {
    // B != 0 means it does not pass through zero at x = 1, so it blurs
    // slightly. In exchange its deepest negative lobe is about a quarter the
    // depth of Lanczos-3's (measured: -0.036 against -0.147), which is the
    // whole trade.
    expect(mitchell(1)).toBeGreaterThan(0);
    const mitchellLobe = Math.abs(Math.min(...sample(mitchell, 0, 2)));
    const lanczosLobe = Math.abs(Math.min(...sample(lanczos3, 0, 3)));
    expect(mitchellLobe).toBeLessThan(lanczosLobe / 3);
  });

  it('lanczos has substantial negative lobes, which is where ringing comes from', () => {
    expect(Math.min(...sample(lanczos3, 0, 3))).toBeLessThan(-0.1);
  });

  it('cubicBC(0, 0.5) reproduces the bicubic preset', () => {
    const custom = cubicBC(0, 0.5);
    for (let x = -2; x <= 2; x += 0.1) {
      expect(custom(x)).toBeCloseTo(bicubic(x), 12);
    }
  });

  it('getKernel resolves every documented name and rejects others', () => {
    for (const name of ['box', 'bilinear', 'bicubic', 'mitchell', 'lanczos2', 'lanczos3', 'lanczos4'] as const) {
      expect(getKernel(name).name).toBe(name);
    }
    // @ts-expect-error deliberately invalid
    expect(() => getKernel('nonexistent')).toThrow(/Unknown kernel/);
  });
});

describe('weight tables', () => {
  it('normalises every output pixel to a total weight of one', () => {
    for (const kernel of ALL) {
      for (const [inSize, outSize] of [
        [10, 20],
        [20, 10],
        [7, 21],
        [64, 65],
        [1, 8],
      ]) {
        const table = buildWeightTable(kernel, inSize, outSize);
        for (let i = 0; i < outSize; i++) {
          let sum = 0;
          for (let t = 0; t < table.taps; t++) sum += table.weights[i * table.taps + t];
          expect(sum, `${kernel.name} ${inSize}->${outSize} pixel ${i}`).toBeCloseTo(1, 5);
        }
      }
    }
  });

  it('widens its window when downscaling so it low-passes instead of aliasing', () => {
    const up = buildWeightTable(lanczos3, 100, 200);
    const down = buildWeightTable(lanczos3, 200, 100);
    expect(down.taps).toBeGreaterThan(up.taps);
    // A 2x reduction stretches the kernel by 2, so the support doubles.
    expect(down.taps).toBeGreaterThanOrEqual(up.taps * 2 - 1);
  });

  it('keeps a uniform stride, so the resampling loop can index it directly', () => {
    const table = buildWeightTable(lanczos3, 33, 100);
    expect(table.weights.length).toBe(table.taps * table.outputSize);
    expect(table.starts.length).toBe(table.outputSize);
  });

  it('gives box exactly one contributing tap, even at half-integer phase', () => {
    // 2x magnification puts every other output pixel at phase 0.5, where the
    // box kernel is zero on both sides. The normaliser has to break that tie
    // deterministically or nearest-neighbour output would come out black.
    const table = buildWeightTable(box, 8, 16);
    for (let i = 0; i < table.outputSize; i++) {
      const taps = Array.from(
        { length: table.taps },
        (_, t) => table.weights[i * table.taps + t],
      );
      const nonZero = taps.filter((w) => w !== 0);
      expect(nonZero, `output pixel ${i}`).toHaveLength(1);
      expect(nonZero[0]).toBeCloseTo(1, 10);
    }
  });

  it('centres identity mappings on the source pixel', () => {
    const table = buildWeightTable(lanczos3, 16, 16);
    for (let i = 0; i < 16; i++) {
      let peakTap = 0;
      let peak = -Infinity;
      for (let t = 0; t < table.taps; t++) {
        const w = table.weights[i * table.taps + t];
        if (w > peak) {
          peak = w;
          peakTap = t;
        }
      }
      expect(table.starts[i] + peakTap).toBe(i);
      // Interpolating kernel at zero phase offset: one tap holds everything.
      expect(peak).toBeCloseTo(1, 6);
    }
  });
});
