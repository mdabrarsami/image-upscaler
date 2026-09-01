# Models

## The built-in catalogue

Two entries, both Real-ESRGAN RRDBNet exported to ONNX with dynamic spatial
dimensions.

| | `realesrgan-x4` | `realesrgan-x2` |
|---|---|---|
| Name | Real-ESRGAN 4x (RRDBNet) | Real-ESRGAN 2x (RRDBNet) |
| Native scale | 4 | 2 |
| Size | 67,051,616 bytes | 67,073,434 bytes |
| SHA-256 | `5c586662929cbc686c1a5c38d9c060dbdb4ea5863a1f7672b8c0761e6b89c033` | `7115ba92e8a1bfa63d68558ef006ef3d91273a068d321b1439f8bb1c9179002c` |
| Licence | BSD-3-Clause | BSD-3-Clause |
| Opset | 17 | 17 |
| Input | `input`, `[1,3,h,w]` f32 RGB in [0,1] | same |
| Output | `output`, `[1,3,4h,4w]` | `[1,3,2h,2w]` |
| Tile / halo | 512 / 16 source px | 512 / 16 |
| Source | [SceneWorks/real-esrgan-onnx](https://huggingface.co/SceneWorks/real-esrgan-onnx) | same |

### Provenance

The ONNX files are exports of the canonical Real-ESRGAN weights
(`RealESRGAN_x4plus.pth` and `RealESRGAN_x2plus.pth`) from
[xinntao/Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN), with no weight
changes. Real-ESRGAN is BSD-3-Clause, which permits redistribution with
attribution, and the export inherits that licence.

### How these values were obtained

None of the numbers above are copied from a model card. Each ONNX file was
downloaded, hashed with `sha256sum`, and loaded into ONNX Runtime to read the
input and output signatures directly. The scale factors were confirmed by
running a 32×32 random tensor through each network and observing 64×64 and
128×128 outputs; the input range was confirmed by feeding a constant 0.5 image
and observing a constant 0.5 output (mean 0.5047, σ 0.0045). The checksums
match the ones the model card publishes independently.

The size and checksum are checked again at runtime, on every load. A file that
does not match is discarded with `MODEL_CORRUPTED` rather than handed to the
runtime.

## Managing models

```ts
const models = await upscaler.models.list();
await upscaler.models.download('realesrgan-x4', { onProgress, signal });
await upscaler.models.isInstalled('realesrgan-x4');
await upscaler.models.usage();        // bytes on disk
await upscaler.models.delete('realesrgan-x4');
await upscaler.models.deleteAll();
```

`download()` de-duplicates concurrent calls for the same id and returns cached
bytes when the version matches. Pass `force: true` to re-fetch.

### Storage

IndexedDB, database `image-upscaler-models`, one record per model holding the
bytes plus version, checksum and timestamp.

IndexedDB rather than Cache Storage because Cache Storage keys on `Request` and
is tied to the fetch that produced it, which makes "the same weights from a
different mirror" awkward and quota inspection opaque. IndexedDB stores a plain
`ArrayBuffer` under a key the library controls, survives reloads, works
offline, and works identically inside a Worker.

A cached entry whose version no longer matches the catalogue is treated as
absent and replaced — which is how a registry update rolls out new weights.

Before downloading, `navigator.storage.estimate()` is consulted where
available. The estimate is coarse and browsers round it, so it only catches
clear-cut cases, and being unable to *cache* is downgraded to a warning rather
than a failure: the bytes are returned and inference proceeds.

## Your own models

### One model

```ts
upscaler.models.register({
  id: 'my-upscaler-x4',
  name: 'My 4x model',
  scale: 4,
  size: 12_345_678,
  version: '1.0.0',
  license: 'Apache-2.0',
  source: 'https://example.com/models',
  url: 'https://cdn.example.com/my-upscaler-x4.onnx',
  sha256: '…64 lowercase hex…',

  preferredTileSize: 256,
  tileOverlap: 16,
  channels: 3,
  inputRange: [0, 1],
  layout: 'nchw',
});

await upscaler.models.download('my-upscaler-x4');
await upscaler.upscale(file, { scale: 4, engine: 'ai', model: 'my-upscaler-x4' });
```

### A whole catalogue

```ts
const upscaler = new ImageUpscaler({
  models: [
    /* your definitions; the built-ins are not included unless you add them */
  ],
  defaultModel: 'my-upscaler-x4',
});
```

Nothing outside the registry knows a model URL, which is what makes this work:
point the catalogue at your own host, an internal mirror, or a bundled asset
path, and no other part of the library changes.

### Requirements

- ONNX, single input, single output.
- NCHW float32, dynamic height and width. Fixed spatial dimensions will fail on
  any tile that is not exactly that size.
- Three channels (RGB) or four (RGBA). Three is normal; alpha is carried
  separately either way. See [AI.md](AI.md).
- Input range `[0, 1]` by default; declare `inputRange` if it differs.

Tensor names are read from the session rather than assumed, so they can be
anything.

### Validation

`register()` rejects a definition rather than failing later:

| Rule | Why |
|---|---|
| `id`, `url`, `license` non-empty | The licence is a redistribution obligation |
| `scale >= 1`, `size > 0` | |
| HTTPS, `blob:`, a relative path, or localhost | A model is executable code as far as the runtime is concerned; plaintext transport is an obvious tampering vector |
| `sha256` is 64 lowercase hex, if present | |
| `layout` is `nchw` | Nothing else is implemented |
| `channels` is 3 or 4 | |

Relative paths are allowed and resolved against the document base, so a model
served from your own origin inherits that origin's transport security.

### Checksums

`sha256` is optional and strongly advised. Without it a corrupted or tampered
file reaches the ONNX parser, and the error you get back is far less
actionable than `MODEL_CORRUPTED`.

```bash
sha256sum my-upscaler-x4.onnx
```

Verification uses WebCrypto, which needs a secure origin. On an insecure origin
the library reports `RUNTIME_UNAVAILABLE` rather than skipping the check.

## Choosing a model for a scale

`registry.findForScale(n)` prefers an exact match; failing that, the largest
native scale that divides `n` cleanly (so 8x uses the 4x model once rather than
the 2x model three times); failing that, the largest model no larger than the
request, with the remainder left to a classical resize.

## Adding a model to the built-in catalogue

If you want to propose one:

1. Confirm the licence permits redistribution, and record it.
2. Publish the file somewhere with permissive CORS and a stable URL.
3. Record the exact byte size and SHA-256 of the file as served.
4. Verify the input and output signature by loading it, not by reading a
   description of it.
5. Confirm the scale and input range empirically, as described above.
6. Add the entry with full attribution.

A model whose licence does not permit redistribution will not be added, even by
reference.
