/**
 * Separable resampling compute shader, shared by both axes.
 *
 * The kernel weights are precomputed on the CPU and uploaded as a flat buffer,
 * exactly as in the CPU path, so GPU and CPU results agree to within float
 * rounding. `axis` selects horizontal (0) or vertical (1), which avoids
 * shipping two nearly identical shaders and lets both passes share one
 * pipeline and one bind-group layout.
 *
 * Buffers are `array<f32>` rather than textures on purpose: the pipeline works
 * in unclamped linear float, and storage textures with f32 RGBA are not
 * universally available, whereas storage buffers are.
 */
export const RESAMPLE_WGSL = /* wgsl */ `
struct Params {
  srcWidth: u32,
  srcHeight: u32,
  dstWidth: u32,
  dstHeight: u32,
  taps: u32,
  axis: u32,
  _pad0: u32,
  _pad1: u32,
};

@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<f32>;
@group(0) @binding(2) var<storage, read> weights: array<f32>;
@group(0) @binding(3) var<storage, read> starts: array<i32>;
@group(0) @binding(4) var<uniform> params: Params;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = gid.x;
  let y = gid.y;
  if (x >= params.dstWidth || y >= params.dstHeight) {
    return;
  }

  let taps = i32(params.taps);
  let maxX = i32(params.srcWidth) - 1;
  let maxY = i32(params.srcHeight) - 1;

  // The filtered axis supplies the tap index; the other axis is a passthrough.
  var tapAxisOut: u32 = x;
  if (params.axis == 1u) {
    tapAxisOut = y;
  }

  let start = starts[tapAxisOut];
  let wBase = i32(tapAxisOut) * taps;

  var acc = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  for (var t: i32 = 0; t < taps; t = t + 1) {
    let w = weights[wBase + t];
    if (w == 0.0) {
      continue;
    }
    var sx: i32 = i32(x);
    var sy: i32 = i32(y);
    if (params.axis == 0u) {
      sx = clamp(start + t, 0, maxX);
    } else {
      sy = clamp(start + t, 0, maxY);
    }
    let si = (sy * i32(params.srcWidth) + sx) * 4;
    acc = acc + vec4<f32>(
      src[si],
      src[si + 1],
      src[si + 2],
      src[si + 3]
    ) * w;
  }

  let di = (i32(y) * i32(params.dstWidth) + i32(x)) * 4;
  dst[di] = acc.x;
  dst[di + 1] = acc.y;
  dst[di + 2] = acc.z;
  dst[di + 3] = acc.w;
}
`;
