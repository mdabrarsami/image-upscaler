import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ImageUpscaler,
  isCancellation,
  UpscalerError,
  type ImageUpscalerConfig,
  type ModelInfo,
  type UpscaleInput,
  type UpscaleOptions,
  type UpscaleProgress,
  type UpscaleResult,
} from '@mdabrarsami/image-upscaler';

export type { ImageUpscalerConfig, UpscaleOptions, UpscaleProgress, UpscaleResult };

/**
 * React bindings.
 *
 * Deliberately thin. The hook owns exactly the four things React makes
 * awkward and nothing else:
 *
 *   - one long-lived `ImageUpscaler` per component, not one per render (it
 *     caches the GPU device, compiled shaders and inference sessions);
 *   - an `AbortController` per run, wired to `cancel` and to unmount;
 *   - progress as state, throttled by the core rather than by a render loop;
 *   - object-URL lifetime, so a preview does not leak on every result.
 *
 * Everything else stays in the core package, which is why the core has no
 * React dependency and this file has no image code.
 */

export interface UseImageUpscalerState {
  /** True while a run is in flight. */
  busy: boolean;
  progress: UpscaleProgress | null;
  result: UpscaleResult | null;
  error: UpscalerError | null;
  /** Object URL for the current result, revoked automatically. */
  resultUrl: string | null;
}

export interface UseImageUpscalerApi extends UseImageUpscalerState {
  upscale(input: UpscaleInput, options?: Omit<UpscaleOptions, 'signal' | 'onProgress'>): Promise<UpscaleResult | null>;
  cancel(): void;
  reset(): void;
  /** The underlying instance, for model management and capability probing. */
  upscaler: ImageUpscaler;
}

const INITIAL: UseImageUpscalerState = {
  busy: false,
  progress: null,
  result: null,
  error: null,
  resultUrl: null,
};

export function useImageUpscaler(config: ImageUpscalerConfig = {}): UseImageUpscalerApi {
  // The config object is usually an inline literal, so identity changes every
  // render. Rebuilding the upscaler for that would throw away every cache it
  // exists to hold, so it is intentionally created once.
  const configRef = useRef(config);
  const upscaler = useMemo(() => new ImageUpscaler(configRef.current), []);

  const [state, setState] = useState<UseImageUpscalerState>(INITIAL);
  const controllerRef = useRef<AbortController | null>(null);
  const urlRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  const revoke = useCallback(() => {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
      revoke();
      void upscaler.dispose();
    };
  }, [upscaler, revoke]);

  const upscale = useCallback<UseImageUpscalerApi['upscale']>(
    async (input, options = {}) => {
      // One run at a time per hook: a second call supersedes the first rather
      // than racing it to set state.
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      revoke();
      setState({ busy: true, progress: null, result: null, error: null, resultUrl: null });

      try {
        const result = await upscaler.upscale(input, {
          ...options,
          signal: controller.signal,
          onProgress: (progress) => {
            // A late progress event from a superseded run must not repaint.
            if (!mountedRef.current || controllerRef.current !== controller) return;
            setState((previous) => ({ ...previous, progress }));
          },
        });

        if (!mountedRef.current || controllerRef.current !== controller) return null;

        const url = URL.createObjectURL(result.blob);
        urlRef.current = url;
        setState({
          busy: false,
          progress: { progress: 1, stage: 'complete' },
          result,
          error: null,
          resultUrl: url,
        });
        return result;
      } catch (caught) {
        if (!mountedRef.current || controllerRef.current !== controller) return null;
        if (isCancellation(caught)) {
          setState(INITIAL);
          return null;
        }
        const error =
          caught instanceof UpscalerError
            ? caught
            : new UpscalerError('INTERNAL', caught instanceof Error ? caught.message : String(caught));
        setState({ busy: false, progress: null, result: null, error, resultUrl: null });
        return null;
      }
    },
    [upscaler, revoke],
  );

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    controllerRef.current?.abort();
    revoke();
    setState(INITIAL);
  }, [revoke]);

  return { ...state, upscale, cancel, reset, upscaler };
}

export interface UseModelsState {
  models: ModelInfo[];
  loading: boolean;
  /** 0..1 while a download is in flight, or null when idle. */
  downloadProgress: number | null;
  downloadingId: string | null;
  error: UpscalerError | null;
}

export interface UseModelsApi extends UseModelsState {
  refresh(): Promise<void>;
  download(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  cancelDownload(): void;
}

/** Model management, for a UI that lets people install and remove weights. */
export function useModels(upscaler: ImageUpscaler): UseModelsApi {
  const [state, setState] = useState<UseModelsState>({
    models: [],
    loading: true,
    downloadProgress: null,
    downloadingId: null,
    error: null,
  });
  const controllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const models = await upscaler.models.list();
      if (mountedRef.current) setState((p) => ({ ...p, models, loading: false, error: null }));
    } catch (caught) {
      if (mountedRef.current) {
        setState((p) => ({ ...p, loading: false, error: UpscalerError.fromSerialized(caught) }));
      }
    }
  }, [upscaler]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
    };
  }, [refresh]);

  const download = useCallback(
    async (id: string) => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      setState((p) => ({ ...p, downloadingId: id, downloadProgress: 0, error: null }));
      try {
        await upscaler.models.download(id, {
          signal: controller.signal,
          onProgress: ({ progress }) => {
            if (mountedRef.current) setState((p) => ({ ...p, downloadProgress: progress }));
          },
        });
        if (mountedRef.current) {
          setState((p) => ({ ...p, downloadingId: null, downloadProgress: null }));
          await refresh();
        }
      } catch (caught) {
        if (!mountedRef.current) return;
        setState((p) => ({
          ...p,
          downloadingId: null,
          downloadProgress: null,
          error: isCancellation(caught) ? null : UpscalerError.fromSerialized(caught),
        }));
      }
    },
    [upscaler, refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      try {
        await upscaler.models.delete(id);
        await refresh();
      } catch (caught) {
        if (mountedRef.current) {
          setState((p) => ({ ...p, error: UpscalerError.fromSerialized(caught) }));
        }
      }
    },
    [upscaler, refresh],
  );

  const cancelDownload = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  return { ...state, refresh, download, remove, cancelDownload };
}
