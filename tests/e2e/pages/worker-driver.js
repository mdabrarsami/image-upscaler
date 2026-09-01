/*
 * Runs entirely inside a module Worker: no `window`, no `document`.
 *
 * If the core ever reaches for a DOM API, this file is where it breaks.
 */
import { ImageUpscaler, detectEnvironment } from '/packages/image-upscaler/dist/image-upscaler.esm.js';

self.addEventListener('message', async (event) => {
  const options = event.data || {};
  try {
    if (typeof document !== 'undefined') {
      throw new Error('this harness is meant to run without a document');
    }

    // Build a test image using only worker-available APIs.
    const size = options.size ?? 48;
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, size, size);
    gradient.addColorStop(0, '#000000');
    gradient.addColorStop(1, '#ffffff');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#ed7532';
    ctx.fillRect(size / 4, size / 4, size / 2, size / 2);
    const blob = await canvas.convertToBlob({ type: 'image/png' });

    // useWorker: false - this *is* the worker; nesting another would only test
    // nested workers.
    const upscaler = new ImageUpscaler({ useWorker: false });
    const stages = [];
    const result = await upscaler.upscale(blob, {
      scale: options.scale ?? 2,
      engine: 'classical',
      mode: options.mode ?? 'balanced',
      onProgress: (p) => stages.push(p.stage),
    });

    self.postMessage({
      ok: true,
      environment: detectEnvironment(),
      width: result.width,
      height: result.height,
      engine: result.engine,
      runtime: result.runtime,
      format: result.format,
      blobSize: result.blob.size,
      processingTime: result.processingTime,
      stages: [...new Set(stages)],
    });
    await upscaler.dispose();
  } catch (error) {
    self.postMessage({
      ok: false,
      code: error && error.code,
      message: (error && error.message) || String(error),
    });
  }
});
