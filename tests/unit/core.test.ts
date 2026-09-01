import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MODE,
  getPreset,
  isSupportedScale,
  listModes,
  planScaleSteps,
  resolveTuning,
  SUPPORTED_SCALES,
} from '../../packages/image-upscaler/src/core/presets.js';
import {
  CancellationError,
  isCancellation,
  throwIfAborted,
  UpscalerError,
} from '../../packages/image-upscaler/src/core/errors.js';
import {
  ProgressReporter,
  STAGE_WEIGHTS,
  stageBase,
} from '../../packages/image-upscaler/src/core/progress.js';
import { UpscaleResultImpl } from '../../packages/image-upscaler/src/core/UpscaleResult.js';
import { chooseOutputFormat } from '../../packages/image-upscaler/src/image/encoder.js';
import { sniffFormat } from '../../packages/image-upscaler/src/image/decoder.js';
import { detectEnvironment } from '../../packages/image-upscaler/src/env/environment.js';
import type { UpscaleProgress } from '../../packages/image-upscaler/src/core/types.js';

describe('mode presets', () => {
  it('exposes every documented mode', () => {
    expect(listModes().sort()).toEqual(
      ['balanced', 'detail', 'document', 'natural', 'pixel-art'].sort(),
    );
    expect(DEFAULT_MODE).toBe('balanced');
  });

  it('keeps every strength inside 0..1', () => {
    for (const mode of listModes()) {
      const preset = getPreset(mode);
      for (const key of [
        'sharpening',
        'detail',
        'noiseReduction',
        'edgeProtection',
        'antiRinging',
        'edgeDirected',
      ] as const) {
        expect(preset[key], `${mode}.${key}`).toBeGreaterThanOrEqual(0);
        expect(preset[key], `${mode}.${key}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('returns a copy, so a caller cannot corrupt the preset table', () => {
    const first = getPreset('balanced');
    first.sharpening = 99;
    expect(getPreset('balanced').sharpening).not.toBe(99);
  });

  it('makes pixel-art bypass every smoothing filter', () => {
    const preset = getPreset('pixel-art');
    expect(preset.nearestNeighbour).toBe(true);
    expect(preset.sharpening).toBe(0);
    expect(preset.detail).toBe(0);
    expect(preset.noiseReduction).toBe(0);
    expect(preset.antiRinging).toBe(0);
    expect(preset.edgeDirected).toBe(0);
  });

  it('makes document mode the most ring-averse and detail mode the most aggressive', () => {
    expect(getPreset('document').antiRinging).toBe(1);
    expect(getPreset('detail').sharpening).toBeGreaterThan(getPreset('natural').sharpening);
    expect(getPreset('detail').detail).toBeGreaterThan(getPreset('natural').detail);
  });

  it('lets per-call options override the preset', () => {
    const tuning = resolveTuning('natural', { sharpening: 0.9, antiRinging: 0.1 });
    expect(tuning.sharpening).toBe(0.9);
    expect(tuning.antiRinging).toBe(0.1);
    // Untouched values still come from the preset.
    expect(tuning.detail).toBe(getPreset('natural').detail);
  });

  it('clamps out-of-range overrides instead of trusting them', () => {
    const tuning = resolveTuning('balanced', { sharpening: 5, detail: -3 });
    expect(tuning.sharpening).toBe(1);
    expect(tuning.detail).toBe(0);
  });

  it('ignores non-finite overrides', () => {
    const tuning = resolveTuning('balanced', { sharpening: Number.NaN });
    expect(tuning.sharpening).toBe(getPreset('balanced').sharpening);
  });

  it('defaults every mode to the sRGB working space', () => {
    // sRGB is the default because it measures better; see the note on
    // `UpscaleOptions.workingSpace` and docs/ALGORITHMS.md.
    for (const mode of listModes()) {
      expect(getPreset(mode).workingSpace, mode).toBe('srgb');
    }
  });

  it('lets a caller opt into linear light', () => {
    expect(resolveTuning('balanced', { workingSpace: 'linear' }).workingSpace).toBe('linear');
    expect(resolveTuning('balanced', {}).workingSpace).toBe('srgb');
  });

  it('rejects an unknown mode', () => {
    // @ts-expect-error deliberately invalid
    expect(() => getPreset('cinematic')).toThrow(/Unknown mode/);
  });
});

describe('scale planning', () => {
  it('accepts exactly the documented factors', () => {
    expect(SUPPORTED_SCALES).toEqual([2, 3, 4, 8]);
    for (const s of [2, 3, 4, 8]) expect(isSupportedScale(s)).toBe(true);
    for (const s of [1, 1.5, 5, 6, 16, 0, -2, '4', null, undefined]) {
      expect(isSupportedScale(s), String(s)).toBe(false);
    }
  });

  it('splits large factors into repeated doublings', () => {
    expect(planScaleSteps(2)).toEqual([2]);
    expect(planScaleSteps(3)).toEqual([3]);
    expect(planScaleSteps(4)).toEqual([2, 2]);
    expect(planScaleSteps(8)).toEqual([2, 2, 2]);
  });

  it('produces steps whose product is the requested factor', () => {
    for (const scale of SUPPORTED_SCALES) {
      const product = planScaleSteps(scale).reduce((a, b) => a * b, 1);
      expect(product, String(scale)).toBe(scale);
    }
  });
});

describe('errors', () => {
  it('carries a stable code and survives instanceof', () => {
    const error = new UpscalerError('OUT_OF_MEMORY', 'too big', { details: { bytes: 5 } });
    expect(error).toBeInstanceOf(UpscalerError);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('OUT_OF_MEMORY');
    expect(error.details).toEqual({ bytes: 5 });
    expect(error.name).toBe('UpscalerError');
  });

  it('preserves the cause chain', () => {
    const cause = new Error('underlying');
    const error = new UpscalerError('INTERNAL', 'wrapped', { cause });
    expect(error.cause).toBe(cause);
  });

  it('round-trips through serialisation, as it must to cross a worker boundary', () => {
    const original = new UpscalerError('MODEL_CORRUPTED', 'bad hash', {
      details: { expected: 'a', actual: 'b' },
    });
    const revived = UpscalerError.fromSerialized(JSON.parse(JSON.stringify(original)));
    expect(revived).toBeInstanceOf(UpscalerError);
    expect(revived.code).toBe('MODEL_CORRUPTED');
    expect(revived.message).toBe('bad hash');
    expect(revived.details).toEqual({ expected: 'a', actual: 'b' });
  });

  it('falls back to INTERNAL for unrecognisable input', () => {
    expect(UpscalerError.fromSerialized('just a string').code).toBe('INTERNAL');
    expect(UpscalerError.fromSerialized(null).code).toBe('INTERNAL');
    expect(UpscalerError.fromSerialized({ nope: 1 }).code).toBe('INTERNAL');
  });

  it('passes an UpscalerError through fromSerialized unchanged', () => {
    const original = new UpscalerError('CANCELLED', 'x');
    expect(UpscalerError.fromSerialized(original)).toBe(original);
  });

  it('recognises cancellation from both its own error and a DOM AbortError', () => {
    expect(isCancellation(new CancellationError())).toBe(true);
    expect(isCancellation(new UpscalerError('CANCELLED', 'x'))).toBe(true);

    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(isCancellation(abort)).toBe(true);

    expect(isCancellation(new UpscalerError('INTERNAL', 'x'))).toBe(false);
    expect(isCancellation(new Error('other'))).toBe(false);
  });

  it('throwIfAborted only throws for an aborted signal', () => {
    const controller = new AbortController();
    expect(() => throwIfAborted(controller.signal)).not.toThrow();
    expect(() => throwIfAborted(undefined)).not.toThrow();
    controller.abort();
    expect(() => throwIfAborted(controller.signal)).toThrow(CancellationError);
  });
});

describe('progress reporting', () => {
  it('does nothing without a callback', () => {
    const reporter = new ProgressReporter();
    expect(reporter.enabled).toBe(false);
    expect(() => {
      reporter.beginStage('upscaling', 0, 1);
      reporter.report(0.5);
      reporter.finish();
    }).not.toThrow();
  });

  it('never goes backwards', () => {
    const seen: number[] = [];
    const reporter = new ProgressReporter((p) => seen.push(p.progress), 0);
    reporter.beginStage('upscaling', 0.2, 0.5);
    reporter.report(0.8);
    reporter.report(0.1); // a stage reporting out of order
    reporter.report(0.9);
    reporter.finish();
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    }
  });

  it('maps a stage fraction into the stage slice', () => {
    const seen: UpscaleProgress[] = [];
    const reporter = new ProgressReporter((p) => seen.push(p), 0);
    reporter.beginStage('upscaling', 0.25, 0.5);
    reporter.report(0.5);
    expect(seen.at(-1)?.progress).toBeCloseTo(0.5, 6);
    expect(seen.at(-1)?.stage).toBe('upscaling');
  });

  it('throttles, so a tiled run cannot flood the callback', () => {
    const seen: UpscaleProgress[] = [];
    // A 50 ms interval with a synchronous burst: only the forced events land.
    const reporter = new ProgressReporter((p) => seen.push(p), 50);
    reporter.beginStage('upscaling', 0, 1);
    for (let i = 0; i < 5000; i++) reporter.report(i / 5000);
    expect(seen.length).toBeLessThan(10);
  });

  it('always emits a terminal complete event at exactly 1', () => {
    const seen: UpscaleProgress[] = [];
    const reporter = new ProgressReporter((p) => seen.push(p), 50);
    reporter.beginStage('decoding', 0, 0.1);
    reporter.finish();
    const last = seen.at(-1);
    expect(last?.stage).toBe('complete');
    expect(last?.progress).toBe(1);
  });

  it('forwards tile counters when a stage supplies them', () => {
    const seen: UpscaleProgress[] = [];
    const reporter = new ProgressReporter((p) => seen.push(p), 0);
    reporter.beginStage('upscaling', 0, 1);
    reporter.report(0.5, { currentTile: 3, totalTiles: 9 });
    expect(seen.at(-1)?.currentTile).toBe(3);
    expect(seen.at(-1)?.totalTiles).toBe(9);
  });

  it('has stage weights that sum to one', () => {
    const total = Object.values(STAGE_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it('has monotonically increasing stage bases', () => {
    const stages = ['decoding', 'analyzing', 'upscaling', 'reconstructing', 'sharpening', 'encoding'] as const;
    let previous = -1;
    for (const stage of stages) {
      const base = stageBase(stage);
      expect(base, stage).toBeGreaterThan(previous);
      previous = base;
    }
    expect(stageBase('encoding') + STAGE_WEIGHTS.encoding).toBeCloseTo(1, 6);
  });
});

describe('output format selection', () => {
  const all = ['png', 'jpeg', 'webp'] as const;

  it('honours an explicit request', () => {
    expect(chooseOutputFormat('webp', 'png', false, [...all])).toBe('webp');
  });

  it('rejects a request the browser cannot encode', () => {
    try {
      chooseOutputFormat('webp', 'png', false, ['png', 'jpeg']);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as UpscalerError).code).toBe('UNSUPPORTED_FORMAT');
    }
  });

  it('keeps the source format when nothing is requested', () => {
    expect(chooseOutputFormat(undefined, 'jpeg', false, [...all])).toBe('jpeg');
    expect(chooseOutputFormat(undefined, 'webp', false, [...all])).toBe('webp');
  });

  it('never silently writes a transparent image as JPEG', () => {
    // Doing so would flatten the alpha against an arbitrary colour, which is
    // data loss the caller did not ask for.
    expect(chooseOutputFormat(undefined, 'jpeg', true, [...all])).toBe('png');
  });

  it('falls back to PNG when the source format is unknown', () => {
    expect(chooseOutputFormat(undefined, null, false, [...all])).toBe('png');
  });

  it('falls back to whatever is available when PNG is not', () => {
    expect(chooseOutputFormat(undefined, null, false, ['jpeg'])).toBe('jpeg');
  });
});

describe('format sniffing', () => {
  it('identifies PNG, JPEG and WebP from their magic bytes', () => {
    expect(sniffFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('png');
    expect(sniffFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(
      sniffFormat(
        new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
      ),
    ).toBe('webp');
  });

  it('returns null rather than guessing', () => {
    expect(sniffFormat(new Uint8Array([1, 2, 3, 4]))).toBeNull();
    expect(sniffFormat(new Uint8Array([]))).toBeNull();
    // A RIFF container that is not WebP (e.g. a WAV file).
    expect(
      sniffFormat(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])),
    ).toBeNull();
  });
});

describe('UpscaleResult', () => {
  const makeResult = (): UpscaleResultImpl =>
    new UpscaleResultImpl({
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
      width: 200,
      height: 100,
      originalWidth: 100,
      originalHeight: 50,
      scale: 2,
      engine: 'classical',
      runtime: 'cpu',
      processingTime: 12.5,
      format: 'png',
    });

  it('exposes the metadata it was built with', () => {
    const result = makeResult();
    expect(result.width).toBe(200);
    expect(result.scale).toBe(2);
    expect(result.engine).toBe('classical');
    expect(result.runtime).toBe('cpu');
    expect(result.format).toBe('png');
  });

  it('reads the blob as an ArrayBuffer', async () => {
    const buffer = await makeResult().arrayBuffer();
    expect(new Uint8Array(buffer)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('memoises its object URL, so a render loop cannot leak', () => {
    const created: string[] = [];
    const revoked: string[] = [];
    vi.stubGlobal('URL', {
      createObjectURL: (blob: Blob) => {
        const url = `blob:test/${created.length}`;
        created.push(url);
        void blob;
        return url;
      },
      revokeObjectURL: (url: string) => revoked.push(url),
    });

    const result = makeResult();
    const first = result.toObjectURL();
    const second = result.toObjectURL();
    expect(first).toBe(second);
    expect(created).toHaveLength(1);

    result.revokeObjectURL();
    expect(revoked).toEqual([first]);
    // A later call mints a fresh URL rather than handing back a dead one.
    expect(result.toObjectURL()).not.toBe(first);

    vi.unstubAllGlobals();
  });

  it('refuses to download outside a DOM instead of failing obscurely', () => {
    try {
      makeResult().download();
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as UpscalerError).code).toBe('RUNTIME_UNAVAILABLE');
      expect((error as UpscalerError).message).toMatch(/needs a DOM/);
    }
  });

  it('serialises without the blob body', () => {
    const json = makeResult().toJSON();
    expect(json).toMatchObject({ width: 200, size: 3, engine: 'classical' });
    expect('blob' in json).toBe(false);
  });
});

describe('environment detection', () => {
  it('identifies Node when there is no window and no worker scope', () => {
    expect(detectEnvironment()).toBe('node');
  });
});
