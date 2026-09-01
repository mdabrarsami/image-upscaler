import { UpscalerError } from '../core/errors.js';
import type { OutputFormat, UpscaleInput } from '../core/types.js';
import {
  createCanvas,
  get2DContext,
  hasCreateImageBitmap,
  hasDocument,
} from '../env/environment.js';
import { surfaceFromImageData, type Surface } from './surface.js';

/**
 * Input normalisation.
 *
 * Every accepted input type is funnelled to `ImageData` and from there to a
 * float `Surface`. The browser's own decoders do the format work, which is the
 * right call: they are hardware-accelerated, handle EXIF orientation and
 * colour profiles, and are already in the binary.
 */

export interface DecodedImage {
  surface: Surface;
  /** Format sniffed from the bytes, when the input carried any. */
  sourceFormat: OutputFormat | null;
}

const MIME_TO_FORMAT: Record<string, OutputFormat> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/webp': 'webp',
};

/**
 * Magic-number sniffing. The `type` on a `File` comes from the OS and is
 * routinely wrong or empty, so the bytes win when both are present.
 */
export function sniffFormat(bytes: Uint8Array): OutputFormat | null {
  if (bytes.length >= 8) {
    if (
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    ) {
      return 'png';
    }
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'webp';
  }
  return null;
}

function isArrayBufferView(value: unknown): value is ArrayBufferView {
  return ArrayBuffer.isView(value);
}

/** Read pixels out of anything drawable. */
function drawToImageData(
  source: CanvasImageSource,
  width: number,
  height: number,
): ImageData {
  if (width <= 0 || height <= 0) {
    throw new UpscalerError('INVALID_INPUT', `Image has zero area (${width}x${height})`);
  }
  const canvas = createCanvas(width, height);
  const ctx = get2DContext(canvas);
  // The default is premultiplied compositing over transparent black, which
  // would round-trip alpha lossily. Copy semantics avoid that.
  ctx.globalCompositeOperation = 'copy';
  ctx.drawImage(source, 0, 0, width, height);
  try {
    return ctx.getImageData(0, 0, width, height);
  } catch (cause) {
    // Reading back from a canvas tainted by a cross-origin image throws.
    throw new UpscalerError(
      'INVALID_INPUT',
      'Cannot read pixels from this image; it may be cross-origin without CORS headers',
      { cause },
    );
  }
}

async function decodeBinary(
  bytes: Uint8Array,
  declaredType?: string,
): Promise<DecodedImage> {
  const sourceFormat = sniffFormat(bytes) ?? (declaredType ? MIME_TO_FORMAT[declaredType] ?? null : null);
  const blob = new Blob([bytes as unknown as BlobPart], {
    type: declaredType || (sourceFormat ? `image/${sourceFormat}` : 'application/octet-stream'),
  });

  if (hasCreateImageBitmap()) {
    let bitmap: ImageBitmap;
    try {
      // `premultiplyAlpha: 'none'` keeps straight alpha, which is what
      // `getImageData` returns and what the pipeline expects on entry.
      bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'default' });
    } catch (cause) {
      throw new UpscalerError('DECODING_FAILED', 'The browser could not decode this image', { cause });
    }
    try {
      const imageData = drawToImageData(bitmap, bitmap.width, bitmap.height);
      return { surface: surfaceFromImageData(imageData), sourceFormat };
    } finally {
      bitmap.close();
    }
  }

  if (!hasDocument()) {
    throw new UpscalerError(
      'RUNTIME_UNAVAILABLE',
      'Decoding binary image data needs createImageBitmap or a DOM',
    );
  }

  // Fallback for hosts without createImageBitmap: an <img> and an object URL.
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImageElement(url);
    const imageData = drawToImageData(img, img.naturalWidth, img.naturalHeight);
    return { surface: surfaceFromImageData(imageData), sourceFormat };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () =>
      reject(new UpscalerError('DECODING_FAILED', 'The browser could not decode this image'));
    img.src = url;
  });
}

export async function decodeInput(input: UpscaleInput): Promise<DecodedImage> {
  if (input == null) {
    throw new UpscalerError('INVALID_INPUT', 'No image was supplied');
  }

  if (typeof ImageData !== 'undefined' && input instanceof ImageData) {
    return { surface: surfaceFromImageData(input), sourceFormat: null };
  }

  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    const buffer = await input.arrayBuffer();
    if (buffer.byteLength === 0) {
      throw new UpscalerError('INVALID_INPUT', 'The supplied file is empty');
    }
    return decodeBinary(new Uint8Array(buffer), input.type);
  }

  if (input instanceof ArrayBuffer) {
    if (input.byteLength === 0) {
      throw new UpscalerError('INVALID_INPUT', 'The supplied buffer is empty');
    }
    return decodeBinary(new Uint8Array(input));
  }

  if (isArrayBufferView(input)) {
    const view = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    if (view.byteLength === 0) {
      throw new UpscalerError('INVALID_INPUT', 'The supplied buffer is empty');
    }
    return decodeBinary(view);
  }

  if (typeof ImageBitmap !== 'undefined' && input instanceof ImageBitmap) {
    return {
      surface: surfaceFromImageData(drawToImageData(input, input.width, input.height)),
      sourceFormat: null,
    };
  }

  if (typeof OffscreenCanvas !== 'undefined' && input instanceof OffscreenCanvas) {
    return {
      surface: surfaceFromImageData(drawToImageData(input, input.width, input.height)),
      sourceFormat: null,
    };
  }

  if (typeof HTMLCanvasElement !== 'undefined' && input instanceof HTMLCanvasElement) {
    return {
      surface: surfaceFromImageData(drawToImageData(input, input.width, input.height)),
      sourceFormat: null,
    };
  }

  if (typeof HTMLImageElement !== 'undefined' && input instanceof HTMLImageElement) {
    if (!input.complete || input.naturalWidth === 0) {
      await input.decode().catch(() => {
        throw new UpscalerError('DECODING_FAILED', 'The supplied <img> has not finished loading');
      });
    }
    return {
      surface: surfaceFromImageData(
        drawToImageData(input, input.naturalWidth, input.naturalHeight),
      ),
      sourceFormat: guessFormatFromUrl(input.currentSrc || input.src),
    };
  }

  throw new UpscalerError(
    'INVALID_INPUT',
    `Unsupported input type: ${Object.prototype.toString.call(input)}`,
  );
}

function guessFormatFromUrl(url: string): OutputFormat | null {
  const match = /\.(png|jpe?g|webp)(?:[?#]|$)/i.exec(url);
  if (!match) return null;
  const ext = match[1].toLowerCase();
  if (ext === 'png') return 'png';
  if (ext === 'webp') return 'webp';
  return 'jpeg';
}
