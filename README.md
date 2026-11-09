# @mdabrarsami/image-upscaler

Client-side image upscaling for the browser. Classical reconstruction always
available; optional local AI super-resolution loaded on demand.

Images never leave the device. There is no backend, no API key, and no account.
The only network request the library can make is downloading an AI model, and
only when you ask it to — [verified by a test that watches every request the
page makes](docs/PRIVACY.md).

```ts
import { ImageUpscaler } from '@mdabrarsami/image-upscaler';

const upscaler = new ImageUpscaler();
const result = await upscaler.upscale(file, { scale: 4 });

document.querySelector('img').src = result.toObjectURL();
```

## Contents

- [Install](#install)
- [Use it](#use-it)
- [Options](#options)
- [Progress and cancellation](#progress-and-cancellation)
- [AI models](#ai-models)
- [Offline](#offline)
- [Browser support](#browser-support)
- [What it actually does](#what-it-actually-does)
- [Documentation](#documentation)

## Install

```bash
npm install @mdabrarsami/image-upscaler
```

The AI runtime is an optional peer. Install it only if you want the AI engine:

```bash
npm install onnxruntime-web
```

## Use it

### ES modules

```ts
import { ImageUpscaler } from '@mdabrarsami/image-upscaler';

const upscaler = new ImageUpscaler();
const result = await upscaler.upscale(file, { scale: 4, engine: 'auto' });

console.log(result.width, result.height, result.engine, result.runtime);
result.download('big.png');
```

Keep one `ImageUpscaler` around rather than constructing one per image. It
caches the GPU device, compiled shaders, filter weight tables and inference
sessions, all of which cost real time to build.

### Script tag

No bundler, no npm, no build step. The bundle installs one global:

```html
<script src="https://unpkg.com/@mdabrarsami/image-upscaler/dist/image-upscaler.min.js"></script>
<script>
  const upscaler = new ImageUpscaler({
    // A classic script has no `import.meta.url`, so the worker cannot be
    // located automatically. Without this the library still works, on the
    // calling thread.
    workerUrl: 'https://unpkg.com/@mdabrarsami/image-upscaler/dist/worker.js',
  });

  document.querySelector('#file').addEventListener('change', async (event) => {
    const result = await upscaler.upscale(event.target.files[0], {
      scale: 4,
      engine: 'auto',
    });
    document.querySelector('#output').src = URL.createObjectURL(result.blob);
  });
</script>
```

`ImageUpscaler` is the class itself, so `new ImageUpscaler()` works exactly as
it does under ESM. The rest of the API hangs off it as statics
(`ImageUpscaler.detectCapabilities()`, `ImageUpscaler.getPreset('detail')`, and
so on).

### React

```tsx
import { useImageUpscaler } from '@mdabrarsami/image-upscaler-react';

function Upscale() {
  const { upscale, busy, progress, resultUrl, error, cancel } = useImageUpscaler();

  return (
    <>
      <input
        type="file"
        onChange={(e) => e.target.files?.[0] && upscale(e.target.files[0], { scale: 4 })}
      />
      {busy && (
        <>
          <progress value={progress?.progress ?? 0} /> {progress?.stage}
          <button onClick={cancel}>Cancel</button>
        </>
      )}
      {error && <p>{error.code}: {error.message}</p>}
      {resultUrl && <img src={resultUrl} alt="" />}
    </>
  );
}
```

The hook is a separate package. The core has no React dependency, and never
will — see [ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Vue

```vue
<script setup>
import { ref } from 'vue';
import { ImageUpscaler } from '@mdabrarsami/image-upscaler';

const upscaler = new ImageUpscaler();
const src = ref(null);

async function onPick(event) {
  const result = await upscaler.upscale(event.target.files[0], { scale: 4 });
  src.value = result.toObjectURL();
}
</script>

<template>
  <input type="file" @change="onPick" />
  <img v-if="src" :src="src" />
</template>
```

### Angular

```ts
import { Component } from '@angular/core';
import { ImageUpscaler } from '@mdabrarsami/image-upscaler';

@Component({
  selector: 'app-upscale',
  template: `
    <input type="file" (change)="onPick($event)" />
    <img *ngIf="src" [src]="src" />
  `,
})
export class UpscaleComponent {
  private readonly upscaler = new ImageUpscaler();
  src: string | null = null;

  async onPick(event: Event): Promise<void> {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const result = await this.upscaler.upscale(file, { scale: 4 });
    this.src = result.toObjectURL();
  }
}
```

### Web Worker

Workers are on by default wherever they exist, so `upscale()` already runs off
the main thread. Nothing to configure. If you want to drive the library from
inside your own worker instead, import it there and pass `useWorker: false`.

### Input types

`upscale()` accepts a `File`, `Blob`, `ArrayBuffer`, any `ArrayBufferView`,
`ImageData`, `ImageBitmap`, `HTMLImageElement`, `HTMLCanvasElement` or
`OffscreenCanvas`. No manual conversion.

## Options

```ts
await upscaler.upscale(image, {
  scale: 4,                    // 2 | 3 | 4 | 8
  engine: 'auto',              // 'auto' | 'classical' | 'ai' | 'hybrid'
  mode: 'balanced',            // natural | balanced | detail | document | pixel-art
  output: { format: 'webp', quality: 0.9 },
  tileSize: 'auto',

  // 0..1, each overriding the mode preset
  sharpening: 0.5,
  detail: 0.5,
  noiseReduction: 0.2,
  edgeProtection: 0.5,
  antiRinging: 0.8,
});
```

### Modes

| Mode | For | Character |
|------|-----|-----------|
| `natural` | Photographs | Conservative. Closest to the source. |
| `balanced` | Anything (default) | Visibly crisper without looking processed. |
| `detail` | Landscapes, architecture | Strong micro-contrast. Too much on skin. |
| `document` | Text, scans, line art | Hard edges, no ringing, no grain. |
| `pixel-art` | Sprites, pixel art | Pure pixel replication. No filtering at all. |

### Engines

| Engine | Needs a download | Notes |
|--------|------------------|-------|
| `classical` | No | Always available. Deterministic. |
| `ai` | Yes (67 MB, once) | Real-ESRGAN. Invents plausible texture. |
| `hybrid` | Yes | AI structure with the real detail of the source put back on top. |
| `auto` | No | AI if a model is already installed and the device can run it, otherwise classical. Never downloads on its own. |

## Progress and cancellation

```ts
const controller = new AbortController();

const result = await upscaler.upscale(file, {
  scale: 8,
  signal: controller.signal,
  onProgress({ progress, stage, currentTile, totalTiles }) {
    console.log(`${Math.round(progress * 100)}% ${stage}`);
  },
});

controller.abort(); // decoding, tiling, inference and encoding all stop
```

Progress is throttled and never goes backwards. Cancellation rejects with
`code: 'CANCELLED'`; `isCancellation(error)` recognises it and a DOM
`AbortError` alike.

## AI models

Nothing is downloaded unless you ask.

```ts
const models = await upscaler.models.list();
// [{ id: 'realesrgan-x4', name: 'Real-ESRGAN 4x (RRDBNet)', scale: 4,
//    size: 67051616, license: 'BSD-3-Clause', installed: false, ... }]

await upscaler.models.download('realesrgan-x4', {
  onProgress: ({ progress }) => console.log(progress),
  signal: controller.signal,
});

await upscaler.models.isInstalled('realesrgan-x4'); // true
await upscaler.models.delete('realesrgan-x4');
```

Weights are verified against a SHA-256 in the registry before use, cached in
IndexedDB, and never re-downloaded. You can point the registry at your own host
or register your own ONNX models — see [MODELS.md](docs/MODELS.md).

The AI runtime is behind a dynamic import, so an application that only ever
uses the classical engine never fetches it. That is
[verified in the test suite](docs/TESTING.md), not just intended.

## Offline

Once a model is installed the AI engine works with the network off: the weights
come from IndexedDB and inference is local. Reload the page, disconnect, and it
still runs. There is a test that does exactly that.

The classical engine has never needed a network at all.

## Browser support

| | Classical | AI (WASM) | AI (WebGPU) | Worker |
|---|---|---|---|---|
| Chrome / Edge 113+ | Yes | Yes | Yes | Yes |
| Firefox | Yes | Yes | Not yet | Yes |
| Safari 16.4+ | Yes | Yes | Behind a flag | Yes |

Everything degrades rather than fails: no WebGPU means the CPU path, no Worker
means the calling thread with a warning, no IndexedDB means AI is unavailable
and `auto` picks classical. Details in
[BROWSER_SUPPORT.md](docs/BROWSER_SUPPORT.md).

## What it actually does

The classical engine is not `drawImage` with extra steps. Per pass:

1. Bilateral denoise at source resolution, scaled by a measured noise estimate.
2. Premultiply alpha (always) and optionally convert to linear light.
3. Extract the high-frequency layer before anything band-limits it.
4. Resample with a windowed-sinc kernel (Lanczos-3, or Lanczos-4 for text).
5. Clamp against the source neighbourhood to remove the sinc kernel's ringing.
6. Edge-directed refinement, using a structure tensor to straighten the
   staircase a separable kernel cannot avoid.
7. Re-inject the detail layer at the new resolution.
8. Adaptive unsharp masking with edge protection and a halo clamp.

Above 2x the whole chain runs once per doubling.

On the benchmark suite the resampler plus anti-ringing scores **25.62 dB PSNR /
0.848 SSIM** against **25.39 dB / 0.840** for `drawImage` at its highest
quality setting, and the hybrid engine reaches the highest SSIM of any method
measured (**0.856**). The sharpening passes trade some of that measured
fidelity for acuity, deliberately and by a documented amount — see
[PERFORMANCE.md](docs/PERFORMANCE.md), which reports the numbers for every mode
including the ones where the library scores worse.

## Documentation

| Document | Contents |
|---|---|
| [API.md](docs/API.md) | Every public export, with types |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the pieces fit and why |
| [ALGORITHMS.md](docs/ALGORITHMS.md) | The maths, and the reasoning behind each choice |
| [AI.md](docs/AI.md) | The AI engine, ONNX Runtime, execution providers |
| [MODELS.md](docs/MODELS.md) | The model registry, custom models, provenance |
| [PERFORMANCE.md](docs/PERFORMANCE.md) | Measured throughput and quality, and the limits |
| [BROWSER_SUPPORT.md](docs/BROWSER_SUPPORT.md) | What works where, and how it degrades |
| [PRIVACY.md](docs/PRIVACY.md) | What leaves the device, and how to check |
| [TESTING.md](docs/TESTING.md) | How it is tested, and what is not covered |
| [LICENSES.md](docs/LICENSES.md) | Licences of the library, dependencies and models |

## Repository layout

```
packages/image-upscaler/        the library
packages/image-upscaler-react/  the React hook
examples/vanilla/               script-tag demo
examples/react/                 React demo (Vite)
examples/electron/              Electron host
benchmarks/                     throughput and quality harness
tests/unit/                     Vitest, pure numerics
tests/e2e/                      Playwright, real browsers
```

## Development

```bash
npm install
npm run lint
npm run test          # unit
npm run build
npm run build:demo    # required before the e2e suite
npm run test:e2e
npm run benchmark     # add --ai to include the AI engine
```

## Licence

MIT. The bundled AI models are BSD-3-Clause and are downloaded at runtime, not
redistributed in the package — see [LICENSES.md](docs/LICENSES.md).
