import { UpscalerError } from '../core/errors.js';
import type { OutputFormat } from '../core/types.js';
import { canvasToBlob, createCanvas, get2DContext } from '../env/environment.js';
import { surfaceToUint8, type Surface } from './surface.js';

/**
 * Output encoding.
 *
 * The browser's own encoders are used: they are native, they honour quality
 * settings, and shipping a PNG/JPEG/WebP encoder in the bundle to do the same
 * job worse would be indefensible for a library whose whole point is being
 * small enough to load client-side.
 */

const MIME: Record<OutputFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

export interface EncodeOptions {
  format: OutputFormat;
  /** 0..1, ignored for PNG. */
  quality?: number;
  /** Colour composited under transparency when the format has no alpha. */
  background?: [number, number, number];
}

export function surfaceToImageData(surface: Surface): ImageData {
  const bytes = surfaceToUint8(surface);
  if (typeof ImageData !== 'undefined') {
    // `surfaceToUint8` always allocates over a plain ArrayBuffer; the standard
    // library type just cannot rule out SharedArrayBuffer.
    return new ImageData(bytes as Uint8ClampedArray<ArrayBuffer>, surface.width, surface.height);
  }
  throw new UpscalerError('RUNTIME_UNAVAILABLE', 'ImageData is not available in this environment');
}

/**
 * JPEG has no alpha channel. Left alone, canvas composites transparent pixels
 * against black, which turns a cut-out logo into a black-fringed mess. Flatten
 * explicitly against a known background instead.
 */
function flattenAlpha(surface: Surface, background: [number, number, number]): Surface {
  const out = new Float32Array(surface.data);
  const [br, bg, bb] = background;
  for (let i = 0; i < out.length; i += 4) {
    const a = out[i + 3];
    if (a >= 1) continue;
    out[i] = out[i] * a + br * (1 - a);
    out[i + 1] = out[i + 1] * a + bg * (1 - a);
    out[i + 2] = out[i + 2] * a + bb * (1 - a);
    out[i + 3] = 1;
  }
  return { ...surface, data: out };
}

export async function encodeSurface(surface: Surface, options: EncodeOptions): Promise<Blob> {
  if (surface.colorSpace !== 'srgb') {
    throw new UpscalerError('INTERNAL', 'Surfaces must be converted back to sRGB before encoding');
  }
  if (surface.premultiplied) {
    throw new UpscalerError('INTERNAL', 'Surfaces must be un-premultiplied before encoding');
  }

  const format = options.format;
  const prepared =
    format === 'jpeg' ? flattenAlpha(surface, options.background ?? [1, 1, 1]) : surface;

  const canvas = createCanvas(prepared.width, prepared.height);
  const ctx = get2DContext(canvas, false);
  ctx.putImageData(surfaceToImageData(prepared), 0, 0);

  const quality = format === 'png' ? undefined : clampQuality(options.quality);
  let blob: Blob;
  try {
    blob = await canvasToBlob(canvas, MIME[format], quality);
  } catch (cause) {
    throw new UpscalerError('ENCODING_FAILED', `Could not encode the result as ${format}`, { cause });
  }

  // A canvas asked for a format it does not support silently produces PNG.
  // Report that rather than lying about the result's format.
  if (blob.type && blob.type !== MIME[format]) {
    throw new UpscalerError(
      'UNSUPPORTED_FORMAT',
      `This browser cannot encode ${format} (it produced ${blob.type})`,
      { details: { requested: format, produced: blob.type } },
    );
  }
  return blob;
}

function clampQuality(quality: number | undefined): number {
  if (quality === undefined) return 0.92;
  if (!Number.isFinite(quality)) return 0.92;
  return quality < 0 ? 0 : quality > 1 ? 1 : quality;
}

/**
 * Pick an output format when the caller did not.
 *
 * Keeping the input's format is the least surprising behaviour, with one
 * exception: an image with real transparency must not be written as JPEG.
 */
export function chooseOutputFormat(
  requested: OutputFormat | undefined,
  sourceFormat: OutputFormat | null,
  hasAlpha: boolean,
  supported: OutputFormat[],
): OutputFormat {
  const isSupported = (f: OutputFormat): boolean => supported.includes(f);

  if (requested) {
    if (!isSupported(requested)) {
      throw new UpscalerError(
        'UNSUPPORTED_FORMAT',
        `This browser cannot encode ${requested}. Available: ${supported.join(', ')}`,
      );
    }
    return requested;
  }

  if (sourceFormat && isSupported(sourceFormat)) {
    if (sourceFormat === 'jpeg' && hasAlpha) return isSupported('png') ? 'png' : 'jpeg';
    return sourceFormat;
  }
  if (isSupported('png')) return 'png';
  return supported[0] ?? 'png';
}
