import { useCallback, useEffect, useState } from 'react';
import type { Capabilities, EngineSelection, ScaleFactor, UpscaleMode } from '@mdabrarsami/image-upscaler';
import { detectCapabilities } from '@mdabrarsami/image-upscaler';
import { useImageUpscaler, useModels } from '@mdabrarsami/image-upscaler-react';

/**
 * React example.
 *
 * Note what is *not* here: no image processing, no worker plumbing, no
 * progress throttling, no object-URL bookkeeping. All of that lives in the
 * framework-agnostic core and the hook. This file is the part that is
 * genuinely React - state, effects and markup.
 */

const ORT_DIR = '/node_modules/onnxruntime-web/dist/';

/**
 * Vite can resolve `onnxruntime-web` itself, so a bundled app does not need a
 * custom loader at all. This one is supplied only so the built demo works when
 * served from the repo's static server, where the runtime lives at a fixed
 * path rather than in a hashed chunk.
 */
const onnxRuntimeLoader = async (): Promise<unknown> => {
  const ort = (await import(/* @vite-ignore */ `${ORT_DIR}ort.wasm.bundle.min.mjs`)) as {
    env: { wasm: { wasmPaths?: string } };
  };
  ort.env.wasm.wasmPaths = ORT_DIR;
  return ort;
};

export function App(): JSX.Element {
  const { busy, progress, result, error, resultUrl, upscale, cancel, upscaler } = useImageUpscaler({
    onnxRuntimeLoader,
  });
  const models = useModels(upscaler);

  const [file, setFile] = useState<File | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [scale, setScale] = useState<ScaleFactor>(2);
  const [engine, setEngine] = useState<EngineSelection>('auto');
  const [mode, setMode] = useState<UpscaleMode>('balanced');
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);

  useEffect(() => {
    void detectCapabilities().then(setCapabilities);
  }, []);

  useEffect(() => {
    if (!file) return undefined;
    const url = URL.createObjectURL(file);
    setSourceUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const onPick = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0];
    if (picked) setFile(picked);
  }, []);

  const onSample = useCallback(async () => {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const gradient = ctx.createLinearGradient(0, 0, size, size);
    gradient.addColorStop(0, '#1b2540');
    gradient.addColorStop(1, '#ed7532');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = '#fff';
    for (let i = 0; i < size; i += 6) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(0, i);
      ctx.stroke();
    }
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 18px system-ui, sans-serif';
    ctx.fillText('React', 10, size - 14);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
    if (blob) setFile(new File([blob], 'sample.png', { type: 'image/png' }));
  }, []);

  const onRun = useCallback(() => {
    if (file) void upscale(file, { scale, engine, mode });
  }, [file, upscale, scale, engine, mode]);

  return (
    <>
      <header>
        <h1>Image Upscaler</h1>
        <p className="lede">
          React example. The core package has no React dependency; this app uses the
          <code> useImageUpscaler </code> hook from the companion package.
        </p>
        {capabilities && (
          <p className="caps" data-testid="capabilities">
            {[
              capabilities.webGPU ? 'WebGPU' : null,
              capabilities.webGL2 ? 'WebGL2' : null,
              capabilities.wasmSimd ? 'WASM+SIMD' : capabilities.wasm ? 'WASM' : null,
              capabilities.workers ? 'Workers' : null,
            ]
              .filter(Boolean)
              .join(', ')}
          </p>
        )}
      </header>

      <main>
        <section className="panel">
          <h2>Image</h2>
          <div className="dropzone">
            <input type="file" accept="image/*" onChange={onPick} data-testid="file" />
            <p className="hint">
              or{' '}
              <button type="button" className="link" onClick={onSample} data-testid="sample">
                generate a test image
              </button>
            </p>
          </div>
        </section>

        <section className="panel">
          <h2>Settings</h2>
          <div className="controls">
            <label>
              Scale
              <select
                data-testid="scale"
                value={scale}
                onChange={(e) => setScale(Number(e.target.value) as ScaleFactor)}
              >
                {[2, 3, 4, 8].map((value) => (
                  <option key={value} value={value}>
                    {value}&times;
                  </option>
                ))}
              </select>
            </label>
            <label>
              Engine
              <select
                data-testid="engine"
                value={engine}
                onChange={(e) => setEngine(e.target.value as EngineSelection)}
              >
                {['auto', 'classical', 'ai', 'hybrid'].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Mode
              <select
                data-testid="mode"
                value={mode}
                onChange={(e) => setMode(e.target.value as UpscaleMode)}
              >
                {['natural', 'balanced', 'detail', 'document', 'pixel-art'].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </section>

        <section className="panel">
          <h2>Models</h2>
          {models.loading ? (
            <p className="hint">Loading&hellip;</p>
          ) : (
            <ul className="models" data-testid="models">
              {models.models.map((model) => (
                <li key={model.id}>
                  <div>
                    <strong>{model.name}</strong>{' '}
                    <span className="badge">{model.scale}&times;</span>
                    <div className="meta">
                      {(model.size / 1e6).toFixed(0)} MB &middot; {model.license}
                    </div>
                  </div>
                  <div className="model-actions">
                    <span className="status">
                      {models.downloadingId === model.id
                        ? `${Math.round((models.downloadProgress ?? 0) * 100)}%`
                        : model.installed
                          ? 'Installed'
                          : 'Not installed'}
                    </span>
                    {model.installed ? (
                      <button type="button" onClick={() => void models.remove(model.id)}>
                        Delete
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={models.downloadingId !== null}
                        onClick={() => void models.download(model.id)}
                      >
                        Download
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel">
          <h2>Run</h2>
          <div className="actions">
            <button type="button" onClick={onRun} disabled={!file || busy} data-testid="run">
              {busy ? 'Working…' : 'Upscale'}
            </button>
            <button type="button" onClick={cancel} disabled={!busy} data-testid="cancel">
              Cancel
            </button>
            {result && (
              <a
                className="link"
                href={resultUrl ?? '#'}
                download={`upscaled-${result.width}x${result.height}.${result.format}`}
                data-testid="download"
              >
                Download result
              </a>
            )}
          </div>

          {progress && (
            <div className="progress">
              <div className="bar">
                <div className="fill" style={{ width: `${Math.round(progress.progress * 100)}%` }} />
              </div>
              <p className="stage" data-testid="stage">
                {Math.round(progress.progress * 100)}% - {progress.stage}
                {progress.totalTiles
                  ? ` (tile ${progress.currentTile} of ${progress.totalTiles})`
                  : ''}
              </p>
            </div>
          )}

          {error && (
            <p className="error" data-testid="error">
              {error.code}: {error.message}
            </p>
          )}

          {result && (
            <dl className="stats" data-testid="stats">
              <dt>Result</dt>
              <dd data-testid="result-size">
                {result.width} x {result.height}
              </dd>
              <dt>Engine</dt>
              <dd data-testid="result-engine">{result.engine}</dd>
              <dt>Runtime</dt>
              <dd data-testid="result-runtime">{result.runtime}</dd>
              <dt>Format</dt>
              <dd>{result.format}</dd>
              <dt>Time</dt>
              <dd>{result.processingTime.toFixed(0)} ms</dd>
            </dl>
          )}
        </section>

        <section className="panel wide">
          <h2>Result</h2>
          <div className="compare">
            {sourceUrl && !resultUrl && <img src={sourceUrl} alt="Source" />}
            {resultUrl && <img src={resultUrl} alt="Upscaled result" data-testid="result-image" />}
          </div>
        </section>
      </main>
    </>
  );
}
