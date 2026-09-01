# @smartapp/image-upscaler-react

React bindings for [`@smartapp/image-upscaler`](https://www.npmjs.com/package/@smartapp/image-upscaler).

A thin hook over the framework-agnostic core. The core has no React dependency;
this package exists only to own the four things React makes awkward.

```bash
npm install @smartapp/image-upscaler @smartapp/image-upscaler-react
```

```tsx
import { useImageUpscaler } from '@smartapp/image-upscaler-react';

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

## What the hook owns

- One long-lived `ImageUpscaler` per component, not one per render. It caches
  the GPU device, compiled shaders and inference sessions, so rebuilding it on
  every render would throw away everything it exists to hold.
- An `AbortController` per run, wired to `cancel` and to unmount.
- Progress as state, throttled by the core rather than by a render loop.
- Object-URL lifetime, so a preview does not leak on every result.

A second call supersedes the first rather than racing it, and a late progress
event from a superseded run cannot repaint.

## `useModels`

```tsx
const models = useModels(upscaler);

models.models;            // ModelInfo[]
models.download(id);      // with progress
models.remove(id);
models.downloadProgress;  // 0..1 or null
models.cancelDownload();
```

## API

```ts
useImageUpscaler(config?: ImageUpscalerConfig): {
  busy: boolean;
  progress: UpscaleProgress | null;
  result: UpscaleResult | null;
  error: UpscalerError | null;
  resultUrl: string | null;
  upscale(input, options?): Promise<UpscaleResult | null>;
  cancel(): void;
  reset(): void;
  upscaler: ImageUpscaler;
}
```

`upscale` resolves to `null` when the run was cancelled or superseded, so a
cancellation is not an error you have to catch.

## Licence

MIT.
