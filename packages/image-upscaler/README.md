# @mdabrarsami/image-upscaler

Client-side image upscaling for the browser. Classical reconstruction always
available; optional local AI super-resolution loaded on demand.

Images never leave the device. No backend, no API key, no account. The only
network request the library can make is downloading an AI model, and only when
you ask for one.

```bash
npm install @mdabrarsami/image-upscaler
```

```ts
import { ImageUpscaler } from '@mdabrarsami/image-upscaler';

const upscaler = new ImageUpscaler();
const result = await upscaler.upscale(file, { scale: 4 });

document.querySelector('img').src = result.toObjectURL();
```

## Highlights

- **Framework agnostic.** No React, Vue, Angular or jQuery in the core. Works
  from a `<script>` tag with no bundler.
- **Runs off the main thread** by default, in a Web Worker, with a documented
  fallback when one is unavailable.
- **Tiling is bit-exact.** A tiled result is identical to a whole-image one, so
  large images cost memory rather than quality.
- **Typed errors** with stable codes that survive the worker boundary.
- **Zero runtime dependencies.** The AI runtime is an optional peer behind a
  dynamic import, so classical-only consumers never download it.

## Engines

| Engine | Download | Notes |
|---|---|---|
| `classical` | None | Lanczos-3 plus anti-ringing, edge-directed refinement, detail reconstruction and adaptive sharpening. Deterministic. |
| `ai` | 67 MB, once | Real-ESRGAN via ONNX Runtime Web, on WebGPU or WASM. |
| `hybrid` | 67 MB, once | AI structure with the source's real detail put back on top. |
| `auto` | None | AI if a model is already installed, classical otherwise. Never downloads on its own. |

On the benchmark suite the classical resampler plus anti-ringing scores
**25.62 dB PSNR / 0.848 SSIM** against **25.39 dB / 0.840** for canvas
`drawImage` at its highest quality.

## Script tag

```html
<script src="https://unpkg.com/@mdabrarsami/image-upscaler/dist/image-upscaler.min.js"></script>
<script>
  const upscaler = new ImageUpscaler();
  const result = await upscaler.upscale(file, { scale: 4 });
</script>
```

The global is the class itself; the rest of the API hangs off it as statics.

## Documentation

Full documentation lives in the repository:

- [README](https://github.com/mdabrarsami/image-upscaler#readme) — usage for React, Vue, Angular, Workers and Electron
- [API](https://github.com/mdabrarsami/image-upscaler/blob/main/docs/API.md)
- [Algorithms](https://github.com/mdabrarsami/image-upscaler/blob/main/docs/ALGORITHMS.md)
- [AI](https://github.com/mdabrarsami/image-upscaler/blob/main/docs/AI.md) and [Models](https://github.com/mdabrarsami/image-upscaler/blob/main/docs/MODELS.md)
- [Performance](https://github.com/mdabrarsami/image-upscaler/blob/main/docs/PERFORMANCE.md)
- [Privacy](https://github.com/mdabrarsami/image-upscaler/blob/main/docs/PRIVACY.md)
- [Browser support](https://github.com/mdabrarsami/image-upscaler/blob/main/docs/BROWSER_SUPPORT.md)

## Licence

MIT. Bundled AI models are BSD-3-Clause and downloaded at runtime, not
redistributed in this package.
