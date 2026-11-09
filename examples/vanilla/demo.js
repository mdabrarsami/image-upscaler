/*
 * Vanilla-JS demo.
 *
 * Loaded from a plain <script> tag with no bundler, no npm, no build step.
 * `ImageUpscaler` is a global installed by image-upscaler.min.js.
 *
 * This file is a demo, not part of the library. It exists to exercise the
 * public API the way a consumer would.
 */
/* global ImageUpscaler */

(function demo() {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const els = {
    capabilities: $('capabilities'),
    dropzone: $('dropzone'),
    file: $('file'),
    sample: $('sample'),
    scale: $('scale'),
    engine: $('engine'),
    mode: $('mode'),
    format: $('format'),
    worker: $('worker'),
    models: $('models'),
    run: $('run'),
    cancelRun: $('cancelRun'),
    download: $('download'),
    progressWrap: $('progressWrap'),
    progressFill: $('progressFill'),
    progressText: $('progressText'),
    error: $('error'),
    stats: $('stats'),
    compare: $('compare'),
    beforeImg: $('beforeImg'),
    afterImg: $('afterImg'),
    afterWrap: $('afterWrap'),
    split: $('split'),
    version: $('version'),
  };

  const sliderIds = ['sharpening', 'detail', 'noiseReduction', 'edgeProtection', 'antiRinging'];

  /** Sliders that the user has actually moved; the rest inherit the preset. */
  const touched = new Set();

  let upscaler = null;
  let currentFile = null;
  let currentResult = null;
  let controller = null;
  let beforeUrl = null;
  let afterUrl = null;

  els.version.textContent = `@mdabrarsami/image-upscaler v${ImageUpscaler.VERSION}`;

  function makeUpscaler() {
    if (upscaler) void upscaler.dispose();
    upscaler = new ImageUpscaler({
      useWorker: els.worker.checked,
      // A classic <script> tag has no import.meta.url, so the worker bundle
      // cannot be located automatically. Pointing at it explicitly is all the
      // library needs; without this it would fall back to the main thread.
      workerUrl: new URL('../../packages/image-upscaler/dist/worker.js', document.baseURI).href,
    });
    return upscaler;
  }

  makeUpscaler();
  els.worker.addEventListener('change', () => {
    makeUpscaler();
    void refreshModels();
  });

  // --- capabilities -------------------------------------------------------

  ImageUpscaler.detectCapabilities().then((caps) => {
    const parts = [
      caps.webGPU ? 'WebGPU' : null,
      caps.webGL2 ? 'WebGL2' : caps.webGL ? 'WebGL' : null,
      caps.wasm ? (caps.wasmSimd ? 'WASM+SIMD' : 'WASM') : null,
      caps.workers ? 'Workers' : null,
      caps.offscreenCanvas ? 'OffscreenCanvas' : null,
      caps.indexedDB ? 'IndexedDB' : null,
    ].filter(Boolean);
    els.capabilities.textContent =
      `Available: ${parts.join(', ')}. Encodes: ${caps.encodableFormats.join(', ')}. ` +
      `Working-memory estimate: ${(caps.estimatedMemory / 1024 / 1024).toFixed(0)} MB` +
      `${caps.estimatedMemoryIsReported ? '' : ' (guessed; this browser does not report it)'}.`;
  });

  // --- input --------------------------------------------------------------

  function setFile(file) {
    currentFile = file;
    els.run.disabled = !file;
    clearResult();
    if (beforeUrl) URL.revokeObjectURL(beforeUrl);
    beforeUrl = URL.createObjectURL(file);
    els.beforeImg.src = beforeUrl;
    els.compare.hidden = true;
  }

  els.file.addEventListener('change', (event) => {
    const [file] = event.target.files || [];
    if (file) setFile(file);
  });

  ['dragenter', 'dragover'].forEach((type) =>
    els.dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      els.dropzone.classList.add('over');
    }),
  );
  ['dragleave', 'drop'].forEach((type) =>
    els.dropzone.addEventListener(type, () => els.dropzone.classList.remove('over')),
  );
  els.dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    const file = event.dataTransfer && event.dataTransfer.files[0];
    if (file) setFile(file);
  });

  /**
   * A generated test image, so the demo is usable without the visitor having
   * to find a file. Deliberately full of the things upscalers struggle with:
   * thin lines, hard diagonals, text-like strokes and a smooth gradient.
   */
  els.sample.addEventListener('click', () => {
    const size = 160;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    const gradient = ctx.createLinearGradient(0, 0, size, size);
    gradient.addColorStop(0, '#1b2540');
    gradient.addColorStop(1, '#ed7532');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    for (let i = 0; i < size; i += 7) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(0, i);
      ctx.stroke();
    }

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 22px system-ui, sans-serif';
    ctx.fillText('Upscale', 12, size - 34);
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText('fine text 0123', 12, size - 16);

    ctx.beginPath();
    ctx.arc(size - 38, 38, 22, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fill();

    canvas.toBlob((blob) => {
      const file = new File([blob], 'sample.png', { type: 'image/png' });
      setFile(file);
    }, 'image/png');
  });

  // --- sliders ------------------------------------------------------------

  sliderIds.forEach((id) => {
    const el = $(id);
    el.addEventListener('input', () => touched.add(id));
  });

  els.mode.addEventListener('change', () => {
    // Show the preset the mode is about to use, and forget any overrides so the
    // control reflects what will actually run.
    const preset = ImageUpscaler.getPreset(els.mode.value);
    touched.clear();
    sliderIds.forEach((id) => {
      $(id).value = String(preset[id]);
    });
  });
  els.mode.dispatchEvent(new Event('change'));

  // --- models -------------------------------------------------------------

  async function refreshModels() {
    let models;
    try {
      models = await upscaler.models.list();
    } catch (error) {
      els.models.innerHTML = `<li>Could not read the model list: ${escapeHtml(String(error))}</li>`;
      return;
    }

    els.models.innerHTML = '';
    models.forEach((model) => {
      const li = document.createElement('li');
      const mb = (model.size / 1e6).toFixed(0);
      li.innerHTML =
        `<div><strong>${escapeHtml(model.name)}</strong> ` +
        `<span class="badge">${model.scale}&times;</span> ` +
        `<span class="meta">${mb} MB &middot; ${escapeHtml(model.license)}</span>` +
        `<div class="meta">${escapeHtml(model.attribution || '')}</div></div>`;

      const actions = document.createElement('div');
      actions.className = 'model-actions';

      const status = document.createElement('span');
      status.className = 'status';
      status.textContent = model.installed ? 'Installed' : 'Not installed';
      actions.appendChild(status);

      if (model.installed) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = 'Delete';
        remove.addEventListener('click', async () => {
          remove.disabled = true;
          await upscaler.models.delete(model.id);
          await refreshModels();
        });
        actions.appendChild(remove);
      } else {
        const get = document.createElement('button');
        get.type = 'button';
        get.textContent = `Download (${mb} MB)`;
        get.addEventListener('click', async () => {
          get.disabled = true;
          const abort = new AbortController();
          const cancel = document.createElement('button');
          cancel.type = 'button';
          cancel.textContent = 'Cancel';
          cancel.addEventListener('click', () => abort.abort());
          actions.appendChild(cancel);

          try {
            await upscaler.models.download(model.id, {
              signal: abort.signal,
              onProgress: ({ progress, loaded, total }) => {
                status.textContent =
                  progress === null
                    ? `${(loaded / 1e6).toFixed(1)} MB`
                    : `${Math.round(progress * 100)}% of ${(total / 1e6).toFixed(0)} MB`;
              },
            });
            await refreshModels();
          } catch (error) {
            status.textContent = describeError(error);
            get.disabled = false;
            cancel.remove();
          }
        });
        actions.appendChild(get);
      }

      li.appendChild(actions);
      els.models.appendChild(li);
    });
  }

  void refreshModels();

  // --- run ----------------------------------------------------------------

  function clearResult() {
    currentResult = null;
    els.download.disabled = true;
    els.stats.hidden = true;
    els.error.hidden = true;
  }

  function buildOptions() {
    const options = {
      scale: Number(els.scale.value),
      engine: els.engine.value,
      mode: els.mode.value,
    };
    if (els.format.value) options.output = { format: els.format.value, quality: 0.92 };
    touched.forEach((id) => {
      options[id] = Number($(id).value);
    });
    return options;
  }

  els.run.addEventListener('click', async () => {
    if (!currentFile) return;
    clearResult();

    controller = new AbortController();
    els.run.disabled = true;
    els.cancelRun.disabled = false;
    els.progressWrap.hidden = false;
    setProgress(0, 'starting');

    const options = buildOptions();
    options.signal = controller.signal;
    options.onProgress = (progress) => {
      const tiles =
        progress.totalTiles && progress.totalTiles > 1
          ? ` (tile ${progress.currentTile} of ${progress.totalTiles})`
          : '';
      setProgress(progress.progress, progress.stage + tiles);
    };

    try {
      const result = await upscaler.upscale(currentFile, options);
      currentResult = result;

      if (afterUrl) URL.revokeObjectURL(afterUrl);
      afterUrl = result.toObjectURL();
      els.afterImg.src = afterUrl;
      els.compare.hidden = false;
      applySplit();

      els.download.disabled = false;
      showStats(result);
    } catch (error) {
      if (ImageUpscaler.isCancellation(error)) {
        els.progressText.textContent = 'Cancelled.';
      } else {
        els.error.hidden = false;
        els.error.textContent = describeError(error);
      }
    } finally {
      els.run.disabled = !currentFile;
      els.cancelRun.disabled = true;
      controller = null;
    }
  });

  els.cancelRun.addEventListener('click', () => controller && controller.abort());

  els.download.addEventListener('click', () => {
    if (currentResult) currentResult.download();
  });

  function setProgress(fraction, label) {
    els.progressFill.style.width = `${Math.round(fraction * 100)}%`;
    els.progressText.textContent = `${Math.round(fraction * 100)}% - ${label}`;
  }

  function showStats(result) {
    els.stats.hidden = false;
    els.stats.innerHTML = '';
    const rows = [
      ['Result', `${result.width} x ${result.height}`],
      ['Original', `${result.originalWidth} x ${result.originalHeight}`],
      ['Engine', result.engine],
      ['Runtime', result.runtime],
      ['Format', result.format],
      ['Size', `${(result.blob.size / 1024).toFixed(0)} KiB`],
      ['Time', `${result.processingTime.toFixed(0)} ms`],
    ];
    rows.forEach(([label, value]) => {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value;
      els.stats.append(dt, dd);
    });
  }

  function describeError(error) {
    if (error && error.code) {
      if (error.code === 'MODEL_NOT_INSTALLED') {
        return 'That engine needs an AI model. Download one in section 3, or use the classical engine.';
      }
      return `${error.code}: ${error.message}`;
    }
    return String(error);
  }

  // --- comparison ---------------------------------------------------------

  function applySplit() {
    const pct = Number(els.split.value);
    els.afterWrap.style.clipPath = `inset(0 0 0 ${pct}%)`;
  }
  els.split.addEventListener('input', applySplit);
  applySplit();

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  }
})();
