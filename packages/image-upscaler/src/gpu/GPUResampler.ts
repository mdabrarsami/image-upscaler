import { buildWeightTable, getKernel, type KernelName, type WeightTable } from '../algorithms/kernels.js';
import { UpscalerError } from '../core/errors.js';
import type { Logger, RuntimeName } from '../core/types.js';
import type { Surface } from '../image/surface.js';
import type { Resampler } from '../engines/ClassicalUpscaler.js';
import { RESAMPLE_WGSL } from './shaders/resample.wgsl.js';
import { WebGPUContext } from './WebGPUContext.js';

const PIPELINE_KEY = 'resample-separable-v1';
const WORKGROUP = 8;

/**
 * WebGPU implementation of the separable resample.
 *
 * Only the resample runs on the GPU. The rest of the classical chain is a
 * handful of cheap passes over the same buffer, and the readback cost of
 * bouncing each one across the PCIe bus would eat the gain. The resample is
 * different: it is O(pixels x taps) with taps up to 8, embarrassingly
 * parallel, and by far the dominant cost.
 *
 * Weight tables are computed by the same CPU code the fallback uses, so the
 * two paths differ only by float accumulation order.
 */
export class GPUResampler implements Resampler {
  readonly runtime: RuntimeName = 'webgpu';

  private readonly context: WebGPUContext;
  private readonly tableCache = new Map<string, WeightTable>();
  private disposed = false;

  constructor(context?: WebGPUContext, logger?: Logger) {
    this.context = context ?? WebGPUContext.get(logger);
  }

  /** Probe once; a failure here means the caller should stay on the CPU. */
  static async create(logger?: Logger): Promise<GPUResampler | null> {
    if (!WebGPUContext.isAvailable()) return null;
    try {
      const context = WebGPUContext.get(logger);
      await context.getDevice();
      return new GPUResampler(context, logger);
    } catch {
      return null;
    }
  }

  private table(kernelName: KernelName, inputSize: number, outputSize: number): WeightTable {
    const key = `${kernelName}:${inputSize}:${outputSize}`;
    let table = this.tableCache.get(key);
    if (!table) {
      table = buildWeightTable(getKernel(kernelName), inputSize, outputSize);
      this.tableCache.set(key, table);
    }
    return table;
  }

  async resample(
    src: Surface,
    outWidth: number,
    outHeight: number,
    kernel: string,
  ): Promise<Surface> {
    if (this.disposed) throw new UpscalerError('GPU_UNAVAILABLE', 'This resampler was disposed');

    const kernelName = kernel as KernelName;
    const device = await this.context.getDevice();
    const pipeline = await this.context.getComputePipeline(PIPELINE_KEY, RESAMPLE_WGSL);

    const hTable = this.table(kernelName, src.width, outWidth);
    const vTable = this.table(kernelName, src.height, outHeight);

    const srcBytes = src.data.byteLength;
    const midBytes = outWidth * src.height * 4 * 4;
    const dstBytes = outWidth * outHeight * 4 * 4;

    const maxBinding = Number(device.limits.maxStorageBufferBindingSize);
    const largest = Math.max(srcBytes, midBytes, dstBytes);
    if (largest > maxBinding) {
      // The caller tiles on the strength of this: it is a real limit, not a
      // failure, so it gets a precise error rather than a silent CPU fallback.
      throw new UpscalerError(
        'OUT_OF_MEMORY',
        `Surface needs a ${largest} byte GPU buffer but the device caps bindings at ${maxBinding}`,
        { details: { required: largest, limit: maxBinding } },
      );
    }

    const buffers: GPUBuffer[] = [];
    const track = <T extends GPUBuffer>(buffer: T): T => {
      buffers.push(buffer);
      return buffer;
    };

    try {
      const srcBuffer = track(
        device.createBuffer({
          label: 'resample-src',
          size: srcBytes,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        }),
      );
      device.queue.writeBuffer(srcBuffer, 0, asGpuSource(src.data));

      const midBuffer = track(
        device.createBuffer({
          label: 'resample-mid',
          size: midBytes,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        }),
      );
      const dstBuffer = track(
        device.createBuffer({
          label: 'resample-dst',
          size: dstBytes,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        }),
      );

      const encoder = device.createCommandEncoder({ label: 'resample' });

      this.encodePass(device, encoder, pipeline, track, {
        src: srcBuffer,
        dst: midBuffer,
        table: hTable,
        srcWidth: src.width,
        srcHeight: src.height,
        dstWidth: outWidth,
        dstHeight: src.height,
        axis: 0,
      });

      this.encodePass(device, encoder, pipeline, track, {
        src: midBuffer,
        dst: dstBuffer,
        table: vTable,
        srcWidth: outWidth,
        srcHeight: src.height,
        dstWidth: outWidth,
        dstHeight: outHeight,
        axis: 1,
      });

      const readback = track(
        device.createBuffer({
          label: 'resample-readback',
          size: dstBytes,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        }),
      );
      encoder.copyBufferToBuffer(dstBuffer, 0, readback, 0, dstBytes);
      device.queue.submit([encoder.finish()]);

      await readback.mapAsync(GPUMapMode.READ);
      const data = new Float32Array(readback.getMappedRange().slice(0));
      readback.unmap();

      return {
        data,
        width: outWidth,
        height: outHeight,
        colorSpace: src.colorSpace,
        premultiplied: src.premultiplied,
      };
    } catch (error) {
      throw this.context.toUpscalerError(error);
    } finally {
      for (const buffer of buffers) buffer.destroy();
    }
  }

  /** `midBuffer` needs STORAGE on both passes, so usage is set by the caller. */
  private encodePass(
    device: GPUDevice,
    encoder: GPUCommandEncoder,
    pipeline: GPUComputePipeline,
    track: <T extends GPUBuffer>(buffer: T) => T,
    pass: {
      src: GPUBuffer;
      dst: GPUBuffer;
      table: WeightTable;
      srcWidth: number;
      srcHeight: number;
      dstWidth: number;
      dstHeight: number;
      axis: 0 | 1;
    },
  ): void {
    const weightsBuffer = track(
      device.createBuffer({
        size: alignTo4(pass.table.weights.byteLength),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      }),
    );
    device.queue.writeBuffer(weightsBuffer, 0, asGpuSource(pass.table.weights));

    const startsBuffer = track(
      device.createBuffer({
        size: alignTo4(pass.table.starts.byteLength),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      }),
    );
    device.queue.writeBuffer(startsBuffer, 0, asGpuSource(pass.table.starts));

    const params = new Uint32Array([
      pass.srcWidth,
      pass.srcHeight,
      pass.dstWidth,
      pass.dstHeight,
      pass.table.taps,
      pass.axis,
      0,
      0,
    ]);
    const paramsBuffer = track(
      device.createBuffer({
        size: params.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      }),
    );
    device.queue.writeBuffer(paramsBuffer, 0, params);

    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: pass.src } },
        { binding: 1, resource: { buffer: pass.dst } },
        { binding: 2, resource: { buffer: weightsBuffer } },
        { binding: 3, resource: { buffer: startsBuffer } },
        { binding: 4, resource: { buffer: paramsBuffer } },
      ],
    });

    const computePass = encoder.beginComputePass();
    computePass.setPipeline(pipeline);
    computePass.setBindGroup(0, bindGroup);
    computePass.dispatchWorkgroups(
      Math.ceil(pass.dstWidth / WORKGROUP),
      Math.ceil(pass.dstHeight / WORKGROUP),
      1,
    );
    computePass.end();
  }

  dispose(): void {
    this.disposed = true;
    this.tableCache.clear();
  }
}

/**
 * Every typed array in this library is allocated over a plain `ArrayBuffer`,
 * never a `SharedArrayBuffer`, but the standard library types cannot express
 * that. This narrows it in one place instead of at each call site.
 */
function asGpuSource(view: ArrayBufferView): GPUAllowSharedBufferSource {
  return view as GPUAllowSharedBufferSource;
}

function alignTo4(bytes: number): number {
  return Math.ceil(bytes / 4) * 4;
}
