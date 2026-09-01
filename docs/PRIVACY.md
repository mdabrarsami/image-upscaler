# Privacy

## The claim

Your images never leave your device.

Not "are deleted after processing", not "are not stored", not "are processed on
servers we control". They are never transmitted. Decoding, upscaling, AI
inference and encoding all happen in the browser tab.

## What the library can send

One thing, and only when you ask for it: a `GET` for AI model weights, from the
URL in the model registry.

That is the complete list. There is no telemetry, no analytics, no error
reporting, no version check, no licence check, no CDN ping.

- The classical engine makes **zero** network requests.
- The AI engine makes **zero** network requests once the model is cached.
- Downloading a model is an explicit `models.download(id)` call. `auto` will
  use a model that is already installed but will never fetch one.

## How to verify it yourself

Do not take this on trust. It takes a minute to check.

1. Open DevTools, Network tab.
2. Load your page and clear the request list.
3. Upscale an image with `engine: 'classical'`.
4. The list stays empty.

For the AI engine, download the model first, then clear the list and upscale.
Also empty.

The stronger check: build the library from source and search the bundle for
`fetch`, `XMLHttpRequest`, `sendBeacon` or `WebSocket`. The only `fetch` is in
`ModelDownloader`, and the only URL it can reach is the one in the registry
entry you asked to download.

## How it is verified here

Three tests in the suite record every request the browser makes — at the
protocol level, so they cover `fetch`, `XHR`, `sendBeacon`, image loads and
anything else — and assert on the result.

| Test | Assertion |
|---|---|
| a classical upscale makes no network request at all | After the page loads, a 4x upscale of a 128×128 image produces an empty request list |
| no request carries image data, and none is a POST | No non-GET request, and no request with a body, during an upscale |
| the only third-party host the library ever contacts is the model host | Across a model download plus an AI upscale, every non-local host is Hugging Face or its CDN |

A fourth test covers the offline claim directly: it downloads a model, then
aborts **every** request outside the page's own origin, reloads, and runs an AI
upscale. It succeeds, and the list of blocked requests is empty — nothing was
even attempted.

These live in [`tests/e2e/ai-models.spec.ts`](../tests/e2e/ai-models.spec.ts).

## What the library stores

| What | Where | Why |
|---|---|---|
| Model weights | IndexedDB, `image-upscaler-models` | So a 67 MB download happens once |
| A debug flag | `localStorage`, `image-upscaler:debug` | Only if you set it |

No images are stored. No identifiers are generated. Nothing is stored unless
you download a model.

Clear it with `await upscaler.models.deleteAll()`, or through the browser's
site-data controls.

## The model download

When you call `models.download(id)`:

- A `GET` to the registry URL. The default catalogue points at Hugging Face.
- `credentials: 'omit'`, so no cookies are sent.
- Nothing about your images, your page or you is included. It is a request for
  a public file.
- The response is verified against a SHA-256 before use.

That host will see an IP address and a user agent, as it would for any file
download. If that matters to you, host the weights yourself and point the
registry at your own URL — see [MODELS.md](MODELS.md). Nothing else in the
library changes.

## Reasoning about the guarantee

The library cannot upload an image even by mistake:

- The only outbound call in the codebase is `fetch(model.url)` in
  `ModelDownloader`, and it sends no body.
- Model URLs must be HTTPS, `blob:`, relative, or localhost. `register()`
  rejects anything else, which closes off both plaintext transport and
  redirect-to-anywhere tricks.
- The processing core is pure numerics on typed arrays and has no access to
  `fetch` at all — no import path from `algorithms/` reaches the network.

## Content Security Policy

The library needs nothing unusual. A policy that permits only your own origin
works, with two additions if you use optional features:

```
# Workers, if enabled (the default)
worker-src 'self' blob:;

# Model downloads, only if you use the AI engine with the default catalogue
connect-src 'self' https://huggingface.co https://*.hf.co;
```

Self-host the weights and `connect-src 'self'` is enough.

There is no `unsafe-eval` requirement for the classical engine. ONNX Runtime
Web's WASM backend may need `'wasm-unsafe-eval'` in some configurations; the
classical engine never does.

## GDPR and similar

No personal data leaves the device, so the library does not act as a data
processor for your images and adds no transfer to any third country. Model
downloads contact whichever host your registry names — if that is a third party
and your assessment requires it, self-host.

This is a description of what the software does, not legal advice.
