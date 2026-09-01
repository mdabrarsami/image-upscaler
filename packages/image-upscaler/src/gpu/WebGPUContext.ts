import { UpscalerError } from '../core/errors.js';
import type { Logger } from '../core/types.js';

/**
 * WebGPU device lifecycle.
 *
 * A `GPUDevice` is expensive to create and can be lost at any moment - driver
 * reset, tab backgrounded on some mobile GPUs, browser reclaiming resources.
 * This wrapper caches one device per page, watches `device.lost`, and marks
 * itself dead so the next call re-acquires instead of submitting work to a
 * corpse.
 */
export class WebGPUContext {
  private static shared: WebGPUContext | undefined;

  private devicePromise: Promise<GPUDevice> | undefined;
  private device: GPUDevice | undefined;
  private lost = false;
  private readonly pipelines = new Map<string, GPUComputePipeline>();
  private readonly shaders = new Map<string, GPUShaderModule>();
  private readonly logger: Logger | undefined;

  constructor(logger?: Logger) {
    this.logger = logger;
  }

  static get(logger?: Logger): WebGPUContext {
    WebGPUContext.shared ??= new WebGPUContext(logger);
    return WebGPUContext.shared;
  }

  static isAvailable(): boolean {
    return typeof navigator !== 'undefined' && 'gpu' in navigator;
  }

  /** True once the device has been lost and not yet re-acquired. */
  get isLost(): boolean {
    return this.lost;
  }

  async getDevice(): Promise<GPUDevice> {
    if (this.device && !this.lost) return this.device;
    this.devicePromise ??= this.acquire();
    try {
      return await this.devicePromise;
    } catch (error) {
      this.devicePromise = undefined;
      throw error;
    }
  }

  private async acquire(): Promise<GPUDevice> {
    if (!WebGPUContext.isAvailable()) {
      throw new UpscalerError('GPU_UNAVAILABLE', 'WebGPU is not available in this browser');
    }
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) {
      throw new UpscalerError('GPU_UNAVAILABLE', 'No WebGPU adapter was returned');
    }

    // Ask for the largest buffers the adapter will grant. The defaults
    // (128 MiB storage binding) are too small for a 4K RGBA float surface,
    // which is what forces tiling far earlier than necessary.
    const limits: Record<string, number> = {};
    for (const key of [
      'maxStorageBufferBindingSize',
      'maxBufferSize',
      'maxComputeWorkgroupStorageSize',
    ] as const) {
      const value = adapter.limits[key];
      if (typeof value === 'number' || typeof value === 'bigint') {
        limits[key] = Number(value);
      }
    }

    let device: GPUDevice;
    try {
      device = await adapter.requestDevice({ requiredLimits: limits });
    } catch (cause) {
      // Some drivers reject the exact limits the adapter advertised. Retry
      // with defaults rather than giving up on the GPU entirely.
      this.logger?.warn('requestDevice rejected the adapter limits; retrying with defaults', cause);
      device = await adapter.requestDevice();
    }

    this.lost = false;
    this.device = device;

    void device.lost.then((info) => {
      this.logger?.warn(`WebGPU device lost (${info.reason}): ${info.message}`);
      this.lost = true;
      this.device = undefined;
      this.devicePromise = undefined;
      this.pipelines.clear();
      this.shaders.clear();
    });

    // Uncaptured validation errors are programming bugs in this library, not
    // consumer errors; surfacing them is how they get fixed.
    device.addEventListener('uncapturederror', (event) => {
      const detail = (event as GPUUncapturedErrorEvent).error;
      this.logger?.error(`WebGPU uncaptured error: ${detail.message}`);
    });

    return device;
  }

  /** Shader modules are cached per source string; compiling is not cheap. */
  async getShaderModule(key: string, code: string): Promise<GPUShaderModule> {
    const device = await this.getDevice();
    let module = this.shaders.get(key);
    if (!module) {
      module = device.createShaderModule({ code, label: key });
      this.shaders.set(key, module);
    }
    return module;
  }

  async getComputePipeline(
    key: string,
    code: string,
    entryPoint = 'main',
  ): Promise<GPUComputePipeline> {
    const device = await this.getDevice();
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      const module = await this.getShaderModule(key, code);
      pipeline = device.createComputePipeline({
        label: key,
        layout: 'auto',
        compute: { module, entryPoint },
      });
      this.pipelines.set(key, pipeline);
    }
    return pipeline;
  }

  /** Wrap a GPU failure in the library's error vocabulary. */
  toUpscalerError(error: unknown): UpscalerError {
    if (error instanceof UpscalerError) return error;
    if (this.lost) {
      return new UpscalerError('GPU_LOST', 'The WebGPU device was lost during processing', {
        cause: error,
      });
    }
    return new UpscalerError('GPU_UNAVAILABLE', `WebGPU operation failed: ${String(error)}`, {
      cause: error,
    });
  }

  destroy(): void {
    this.pipelines.clear();
    this.shaders.clear();
    this.device?.destroy();
    this.device = undefined;
    this.devicePromise = undefined;
    if (WebGPUContext.shared === this) WebGPUContext.shared = undefined;
  }
}
