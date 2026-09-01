# Browser support

## Baseline

Anything with ES2022, `OffscreenCanvas` or a DOM canvas, and `createImageBitmap`
or an `<img>` element. In practice: Chrome/Edge 94+, Firefox 105+, Safari 16.4+.

The classical engine works everywhere in that range with no configuration.

## Feature matrix

| | Chrome / Edge 113+ | Firefox | Safari 16.4+ |
|---|---|---|---|
| Classical engine | Yes | Yes | Yes |
| Web Worker | Yes | Yes | Yes |
| `OffscreenCanvas` | Yes | Yes | Yes (16.4+) |
| WebGPU resample | Yes | Behind a flag | Behind a flag (17.4+) |
| AI on WASM | Yes | Yes | Yes |
| AI on WebGPU | Yes | No | No |
| WASM SIMD | Yes | Yes | Yes |
| WASM threads | With COOP/COEP | With COOP/COEP | With COOP/COEP |
| IndexedDB model cache | Yes | Yes | Yes (see below) |
| PNG / JPEG output | Yes | Yes | Yes |
| WebP output | Yes | Yes | Yes (14+) |

Nothing here is inferred from a user agent string. `detectCapabilities()`
probes: it requests a real WebGPU adapter, validates a real SIMD module, and
asks a real canvas which MIME types it will encode.

## Degradation

Every optional capability has a defined fallback, and every fallback is tested.

| Missing | What happens |
|---|---|
| WebGPU | CPU resample. `result.runtime` says `cpu`. |
| Worker | Runs on the calling thread, with a warning that the UI may block. |
| `OffscreenCanvas` | A DOM canvas is used instead. |
| `createImageBitmap` | An `<img>` plus an object URL. |
| IndexedDB | AI unavailable; `auto` picks classical. Downloads still work, they just are not cached. |
| WebP encoding | The format falls back; an *explicit* `format: 'webp'` throws `UNSUPPORTED_FORMAT` rather than silently returning PNG. |
| WebCrypto | Checksums cannot be verified, so model download reports `RUNTIME_UNAVAILABLE`. Usually means an insecure origin. |

The one thing that does not degrade is an explicit engine request. `engine:
'ai'` with no model throws. `auto` is the setting that means "whatever works".

## Notes per browser

### Chrome and Edge

The best-supported path. WebGPU since 113 on Windows, macOS and ChromeOS;
Linux needs a flag on many distributions. WebGPU AI inference is
Chromium-only today.

### Firefox

Everything except WebGPU, which is still behind `dom.webgpu.enabled`. AI runs
on WASM and works correctly, just slower. The classical engine is unaffected.

### Safari

`OffscreenCanvas` arrived in 16.4, which sets the floor. WebGPU exists in 17.4+
behind a feature flag.

Two Safari-specific behaviours worth knowing:

- **Storage eviction.** Safari evicts IndexedDB from sites without recent user
  interaction, on a roughly seven-day timer. A cached model can disappear. The
  library handles this correctly — the model simply reads as not installed and
  can be downloaded again — but a UI that assumes "installed" is permanent will
  be surprised. Re-check `isInstalled()` rather than caching the answer.
- **Private browsing.** IndexedDB may be unavailable entirely, in which case AI
  is unavailable and `auto` picks classical.

### Mobile

The classical engine works on mobile Safari and Chrome. Two cautions:

- Memory budgets are far smaller, and `navigator.deviceMemory` is unavailable
  on iOS, so the estimate is a conservative guess. Large images tile earlier
  than they need to, which is the right way to be wrong.
- A 67 MB model download is a real cost on a metered connection. Show the size
  before downloading; `models.list()` provides it.

### Electron

Works unmodified — the renderer is Chromium, and the environment adapters
already cover it. No Electron-specific build. There is a runnable example in
[`examples/electron/`](../examples/electron/) and a Playwright test that drives
it, which skips unless Electron is installed (it is not a dependency of this
repo).

## Cross-origin isolation

Only relevant to AI-on-WASM throughput. Without these headers ONNX Runtime Web
is single-threaded:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The library detects `crossOriginIsolated` and caps thread count accordingly
rather than requesting threads it cannot have. Isolation also constrains what
else your page may embed, so it is a decision to make deliberately.

## Cross-origin images

Reading pixels from a canvas tainted by a cross-origin image throws. If you
pass an `HTMLImageElement` loaded from another origin, set `crossOrigin =
'anonymous'` and serve it with permissive CORS. The library reports this as
`INVALID_INPUT` with an explanation rather than a `SecurityError`.

## What was actually tested here

Chromium 151 (Playwright's bundled build), headless, on Windows x64. The full
Playwright suite passes there.

Firefox and WebKit projects are configured in `playwright.config.ts` and the
suite is written so every test either works on all three or skips itself with a
stated reason, but they were **not** executed in this environment — only the
Chromium browser was installable. The matrix above reflects documented platform
support, not three-engine test runs.

WebGPU was also not exercised: Playwright's headless shell does not expose
`navigator.gpu`, and this environment cannot launch the full Chromium binary.
The GPU tests skip with that reason rather than passing vacuously. See
[TESTING.md](TESTING.md).
