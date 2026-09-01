# Benchmark results

Generated 2026-09-01T11:08:05.104Z

## Environment

| Item          | Value              |
|---------------|--------------------|
| Chromium      | 151.0.7922.34      |
| Node          | v26.3.1            |
| Platform      | win32 x64          |
| Logical cores | 32                 |
| WebGPU        | false              |
| WebGL2        | true               |
| WASM SIMD     | true               |
| Memory budget | 4295 MB (reported) |


## Throughput

Median wall-clock time for a complete call, decode and PNG encode included.

| Source    | Scale | Engine    | Mode     | Runtime | Tiles | Median ms | MP/s  | Result    |
|-----------|-------|-----------|----------|---------|-------|-----------|-------|-----------|
| 640x480   | 2x    | canvas    | -        | cpu     | 1     | 43        | 28.31 | 1280x960  |
| 640x480   | 2x    | classical | natural  | cpu     | 1     | 702       | 1.75  | 1280x960  |
| 640x480   | 2x    | classical | balanced | cpu     | 1     | 684       | 1.80  | 1280x960  |
| 640x480   | 2x    | ai        | balanced | wasm    | 1     | 70125     | 0.02  | 1280x960  |
| 640x480   | 2x    | hybrid    | balanced | wasm    | 1     | 134607    | 0.01  | 1280x960  |
| 640x480   | 4x    | canvas    | -        | cpu     | 1     | 317       | 15.49 | 2560x1920 |
| 640x480   | 4x    | classical | natural  | cpu     | 1     | 4820      | 1.02  | 2560x1920 |
| 640x480   | 4x    | classical | balanced | cpu     | 1     | 5092      | 0.97  | 2560x1920 |
| 640x480   | 8x    | canvas    | -        | cpu     | 1     | 1202      | 16.36 | 5120x3840 |
| 640x480   | 8x    | classical | natural  | cpu     | 1     | 19832     | 0.99  | 5120x3840 |
| 640x480   | 8x    | classical | balanced | cpu     | 1     | 20370     | 0.97  | 5120x3840 |
| 1280x720  | 2x    | canvas    | -        | cpu     | 1     | 254       | 14.54 | 2560x1440 |
| 1280x720  | 2x    | classical | natural  | cpu     | 1     | 3415      | 1.08  | 2560x1440 |
| 1280x720  | 2x    | classical | balanced | cpu     | 1     | 3283      | 1.12  | 2560x1440 |
| 1280x720  | 2x    | ai        | balanced | wasm    | 1     | 372833    | 0.01  | 2560x1440 |
| 1280x720  | 2x    | hybrid    | balanced | wasm    | 6     | 457301    | 0.01  | 2560x1440 |
| 1280x720  | 4x    | canvas    | -        | cpu     | 1     | 971       | 15.18 | 5120x2880 |
| 1280x720  | 4x    | classical | natural  | cpu     | 1     | 14416     | 1.02  | 5120x2880 |
| 1280x720  | 4x    | classical | balanced | cpu     | 1     | 14618     | 1.01  | 5120x2880 |
| 1920x1080 | 2x    | canvas    | -        | cpu     | 1     | 637       | 13.01 | 3840x2160 |
| 1920x1080 | 2x    | classical | natural  | cpu     | 1     | 7343      | 1.13  | 3840x2160 |
| 1920x1080 | 2x    | classical | balanced | cpu     | 1     | 7470      | 1.11  | 3840x2160 |
| 1920x1080 | 4x    | canvas    | -        | cpu     | 1     | 2233      | 14.86 | 7680x4320 |
| 1920x1080 | 4x    | classical | natural  | cpu     | 1     | 31262     | 1.06  | 7680x4320 |
| 1920x1080 | 4x    | classical | balanced | cpu     | 1     | 19281     | 1.72  | 7680x4320 |
| 2560x1440 | 2x    | canvas    | -        | cpu     | 1     | 612       | 24.08 | 5120x2880 |
| 2560x1440 | 2x    | classical | natural  | cpu     | 1     | 7605      | 1.94  | 5120x2880 |
| 2560x1440 | 2x    | classical | balanced | cpu     | 1     | 13300     | 1.11  | 5120x2880 |
| 3840x2160 | 2x    | canvas    | -        | cpu     | 1     | 2457      | 13.50 | 7680x4320 |
| 3840x2160 | 2x    | classical | natural  | cpu     | 1     | 29538     | 1.12  | 7680x4320 |
| 3840x2160 | 2x    | classical | balanced | cpu     | 1     | 29709     | 1.12  | 7680x4320 |


## Limits

Sizes where the question is whether the library copes at all, rather than how fast. Not timed against a baseline: at these resolutions the browser PNG encoder dominates the measurement.

| Source    | Scale | Output MP | Outcome                  | Time     | Tiles |
|-----------|-------|-----------|--------------------------|----------|-------|
| 6000x4000 | 2x    | 96        | handled                  | 88528 ms | 24    |
| 8000x6000 | 2x    | 192       | refused: IMAGE_TOO_LARGE | -        | -     |
| 4000x3000 | 4x    | 192       | refused: IMAGE_TOO_LARGE | -        | -     |
| 8000x6000 | 8x    | 3072      | refused: IMAGE_TOO_LARGE | -        | -     |


## Quality

Each source is rendered at full size, downscaled, then enlarged back and compared with the original. Higher PSNR and SSIM are better; lower MAE and MSE are better.


### 512x512 at 2x

| Method                         | PSNR dB | SSIM   | MAE   | MSE   |
|--------------------------------|---------|--------|-------|-------|
| canvas nearest                 | 21.52   | 0.7778 | 12.41 | 458.3 |
| canvas low                     | 23.91   | 0.8199 | 9.93  | 264.3 |
| canvas high (drawImage)        | 24.21   | 0.8299 | 9.71  | 246.4 |
| raw lanczos3 (linear light)    | 22.42   | 0.7927 | 12.13 | 372.3 |
| raw lanczos3 (sRGB space)      | 24.41   | 0.8406 | 9.76  | 235.5 |
| raw bicubic (sRGB space)       | 24.29   | 0.8386 | 9.65  | 242.0 |
| raw bilinear (sRGB space)      | 23.91   | 0.8199 | 9.92  | 264.3 |
| lanczos3 only (no enhancement) | 24.39   | 0.8386 | 9.86  | 236.7 |
| lanczos3 + anti-ring           | 24.42   | 0.8391 | 9.80  | 234.9 |
| classical natural              | 23.48   | 0.8268 | 11.01 | 291.7 |
| classical balanced             | 21.65   | 0.7939 | 14.07 | 444.6 |
| classical detail               | 20.49   | 0.7677 | 16.32 | 581.3 |
| classical document             | 21.66   | 0.7966 | 13.98 | 443.8 |
| AI (Real-ESRGAN 2x)            | 24.25   | 0.8499 | 9.33  | 244.6 |
| hybrid                         | 23.53   | 0.8563 | 10.27 | 288.2 |

### 512x512 at 4x

| Method                         | PSNR dB | SSIM   | MAE   | MSE    |
|--------------------------------|---------|--------|-------|--------|
| canvas nearest                 | 17.99   | 0.5130 | 21.00 | 1032.5 |
| canvas low                     | 19.17   | 0.5445 | 18.15 | 786.6  |
| canvas high (drawImage)        | 19.22   | 0.5532 | 18.19 | 778.8  |
| raw lanczos3 (linear light)    | 18.42   | 0.5240 | 20.91 | 936.2  |
| raw lanczos3 (sRGB space)      | 19.24   | 0.5782 | 18.64 | 774.1  |
| raw bicubic (sRGB space)       | 19.20   | 0.5697 | 18.49 | 781.2  |
| raw bilinear (sRGB space)      | 19.16   | 0.5444 | 18.23 | 789.6  |
| lanczos3 only (no enhancement) | 19.13   | 0.5756 | 18.92 | 794.8  |
| lanczos3 + anti-ring           | 19.12   | 0.5733 | 18.91 | 796.9  |
| classical natural              | 18.36   | 0.5684 | 20.84 | 948.3  |
| classical balanced             | 16.38   | 0.5223 | 26.12 | 1495.0 |
| classical detail               | 14.92   | 0.4795 | 31.14 | 2093.9 |
| classical document             | 16.30   | 0.5193 | 26.16 | 1526.0 |

### 1024x768 at 2x

| Method                         | PSNR dB | SSIM   | MAE   | MSE   |
|--------------------------------|---------|--------|-------|-------|
| canvas nearest                 | 22.44   | 0.7930 | 10.61 | 370.6 |
| canvas low                     | 25.06   | 0.8308 | 8.41  | 202.9 |
| canvas high (drawImage)        | 25.39   | 0.8397 | 8.19  | 187.8 |
| raw lanczos3 (linear light)    | 23.48   | 0.8091 | 10.24 | 291.8 |
| raw lanczos3 (sRGB space)      | 25.49   | 0.8488 | 8.35  | 183.6 |
| raw bicubic (sRGB space)       | 25.44   | 0.8475 | 8.16  | 185.9 |
| raw bilinear (sRGB space)      | 25.06   | 0.8307 | 8.40  | 202.8 |
| lanczos3 only (no enhancement) | 25.57   | 0.8478 | 8.34  | 180.5 |
| lanczos3 + anti-ring           | 25.62   | 0.8482 | 8.26  | 178.4 |
| classical natural              | 24.56   | 0.8373 | 9.42  | 227.6 |
| classical balanced             | 22.59   | 0.8082 | 12.13 | 358.0 |
| classical detail               | 21.38   | 0.7846 | 14.04 | 473.3 |
| classical document             | 22.64   | 0.8119 | 12.00 | 354.0 |
| AI (Real-ESRGAN 2x)            | 24.97   | 0.8475 | 8.46  | 206.8 |
| hybrid                         | 24.35   | 0.8555 | 9.20  | 239.0 |
