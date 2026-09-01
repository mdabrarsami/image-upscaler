# Licences

## This library

MIT, for both packages:

- `@smartapp/image-upscaler`
- `@smartapp/image-upscaler-react`

See [LICENSE](../LICENSE).

## Runtime dependencies

The core package has **no runtime dependencies**. Nothing is bundled into
`dist/` except the library's own code.

| Package | Relationship | Licence |
|---|---|---|
| `onnxruntime-web` | Optional peer, loaded dynamically | MIT |
| `react` | Peer of the React package only | MIT |

`onnxruntime-web` is never bundled. It is an optional peer dependency behind a
dynamic import, so a consumer who does not use the AI engine neither installs
nor downloads it.

## AI models

**Models are not redistributed in the package.** They are downloaded at runtime
from the URL in the registry, only when the consumer calls
`models.download()`. The npm package contains no weights.

### Real-ESRGAN (`realesrgan-x2`, `realesrgan-x4`)

| | |
|---|---|
| Licence | BSD-3-Clause |
| Upstream | [xinntao/Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) |
| Authors | Xintao Wang, Liangbin Xie, Chao Dong, Ying Shan |
| ONNX export | [SceneWorks/real-esrgan-onnx](https://huggingface.co/SceneWorks/real-esrgan-onnx) |
| Export licence | BSD-3-Clause, inherited |
| Paper | *Real-ESRGAN: Training Real-World Blind Super-Resolution with Pure Synthetic Data*, ICCV Workshops 2021 |

BSD-3-Clause permits redistribution in source and binary form with attribution
and the licence text. The export is a 1:1 conversion of the canonical weights
with no changes.

If you ship an application that uses these models, include the attribution:

> Upscaling by Real-ESRGAN (Xintao Wang et al.), BSD-3-Clause.
> https://github.com/xinntao/Real-ESRGAN

`models.list()` returns `license`, `source` and `attribution` for every entry,
so an application can surface this from data rather than hard-coding it.

### Adding a model

A model whose licence does not permit redistribution will not be added to the
built-in catalogue, even by reference. Several well-known super-resolution
checkpoints are research-only or non-commercial; those are not eligible.

If you register your own model, its licence is your responsibility. The
`license` field is required by `register()` for that reason — it is a
redistribution obligation, not documentation.

## Development dependencies

Not shipped. Present for building and testing.

| Package | Licence |
|---|---|
| `typescript` | Apache-2.0 |
| `tsup` / `esbuild` | MIT |
| `vitest` | MIT |
| `@playwright/test` | Apache-2.0 |
| `eslint`, `typescript-eslint` | MIT |
| `vite`, `@vitejs/plugin-react` | MIT |
| `@webgpu/types` | BSD-3-Clause |
| `globals` | MIT |
| `rimraf` | ISC |

`npm ls --omit=dev` on the published package returns an empty tree.

## Algorithms

Every algorithm is implemented from its published description; no code was
copied from another project.

The references, for anyone wanting to check the implementations:

- **Lanczos resampling** — the standard windowed-sinc construction.
- **Keys' cubic family** — R. Keys, *Cubic convolution interpolation for digital
  image processing*, IEEE ASSP 1981. Catmull-Rom is B=0, C=0.5.
- **Mitchell-Netravali** — D. Mitchell and A. Netravali, *Reconstruction filters
  in computer graphics*, SIGGRAPH 1988. B=C=1/3.
- **Scharr operator** — H. Scharr's optimised 3×3 kernels, derived to minimise
  angular error in the gradient direction.
- **Structure tensor** — the standard second-moment matrix formulation.
- **Bilateral filter** — C. Tomasi and R. Manduchi, *Bilateral filtering for gray
  and color images*, ICCV 1998.
- **Anti-ringing clamp** — the neighbourhood-clamp technique used in video
  scalers such as mpv and madVR.
- **Unsharp masking with edge protection and halo suppression** — conventional
  practice; the specific gain and knee shaping here is this library's own.

## Trademarks

Real-ESRGAN, ONNX and WebGPU are the marks of their respective owners.
Referenced descriptively; no affiliation or endorsement is implied.
