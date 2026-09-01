import type { ProgressStage, UpscaleProgress } from './types.js';
import { nowMs } from '../env/environment.js';

/**
 * Progress reporting.
 *
 * Two properties matter to a consumer wiring this to a progress bar: the value
 * never goes backwards, and the callback does not fire thousands of times a
 * second. A tiled 8x run produces tens of thousands of internal progress
 * updates; forwarding all of them would cost more than the work being
 * reported.
 */
const DEFAULT_INTERVAL_MS = 50;

export class ProgressReporter {
  private readonly callback: ((progress: UpscaleProgress) => void) | undefined;
  private readonly intervalMs: number;
  private lastEmit = -Infinity;
  private lastValue = 0;
  private base = 0;
  private span = 1;
  private stage: ProgressStage = 'decoding';

  constructor(callback?: (progress: UpscaleProgress) => void, intervalMs = DEFAULT_INTERVAL_MS) {
    this.callback = callback;
    this.intervalMs = intervalMs;
  }

  get enabled(): boolean {
    return this.callback !== undefined;
  }

  /**
   * Claim a slice of the overall 0..1 range for the next stage. Sub-progress
   * reported through `report` is mapped into that slice, so a stage never has
   * to know where it sits in the whole run.
   */
  beginStage(stage: ProgressStage, base: number, span: number): void {
    this.stage = stage;
    this.base = base;
    this.span = span;
    this.emit(0, true);
  }

  /** `fraction` is 0..1 within the current stage. */
  report(fraction: number, extra?: { currentTile?: number; totalTiles?: number }): void {
    this.emit(fraction, false, extra);
  }

  /** Force a final `complete` event regardless of throttling. */
  finish(): void {
    this.stage = 'complete';
    this.base = 1;
    this.span = 0;
    this.lastValue = 1;
    this.callback?.({ progress: 1, stage: 'complete' });
  }

  private emit(
    fraction: number,
    force: boolean,
    extra?: { currentTile?: number; totalTiles?: number },
  ): void {
    if (!this.callback) return;
    const value = Math.min(1, Math.max(0, this.base + this.span * clamp01(fraction)));
    // Monotonic: a stage that finishes early must not rewind the bar.
    if (value < this.lastValue) return;

    const now = nowMs();
    if (!force && now - this.lastEmit < this.intervalMs && value < 1) return;

    this.lastEmit = now;
    this.lastValue = value;
    const payload: UpscaleProgress = { progress: value, stage: this.stage };
    if (extra?.currentTile !== undefined) payload.currentTile = extra.currentTile;
    if (extra?.totalTiles !== undefined) payload.totalTiles = extra.totalTiles;
    this.callback(payload);
  }
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Fixed slice of the 0..1 bar for each stage.
 *
 * These are rough measurements from the benchmark suite rather than equal
 * thirds: decoding a JPEG is fast, the resample dominates, and encoding a
 * large PNG is slower than people expect.
 */
export const STAGE_WEIGHTS: Record<Exclude<ProgressStage, 'complete'>, number> = {
  decoding: 0.06,
  analyzing: 0.04,
  upscaling: 0.55,
  reconstructing: 0.14,
  sharpening: 0.11,
  encoding: 0.1,
};

/** Cumulative start offset of each stage. */
export function stageBase(stage: Exclude<ProgressStage, 'complete'>): number {
  let base = 0;
  for (const [name, weight] of Object.entries(STAGE_WEIGHTS)) {
    if (name === stage) return base;
    base += weight;
  }
  return base;
}
