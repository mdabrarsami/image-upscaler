#!/usr/bin/env node
/**
 * Benchmark driver.
 *
 * Runs the real library in a real browser and writes both a JSON record and a
 * Markdown table. Nothing here estimates or extrapolates: every number printed
 * was measured on the machine that ran this script, and every case that failed
 * is printed as a failure with its error code rather than being dropped.
 *
 *   node benchmarks/run.mjs            # throughput + quality, no AI
 *   node benchmarks/run.mjs --ai       # also download the model and score it
 *   node benchmarks/run.mjs --quick    # a small subset, for a sanity check
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { fmt, renderMarkdown } from './report.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4174;
const BASE = `http://localhost:${PORT}`;

const args = new Set(process.argv.slice(2));
const WITH_AI = args.has('--ai');
const QUICK = args.has('--quick');

/**
 * Throughput grid.
 *
 * Larger cases get fewer runs: a 4K 4x pass takes minutes, and three of them
 * would not make the median meaningfully better.
 */
const THROUGHPUT = QUICK
  ? [
      { width: 640, height: 480, scales: [2, 4], runs: 3, warmup: 1 },
      { width: 1280, height: 720, scales: [2], runs: 2, warmup: 1 },
    ]
  : [
      { width: 640, height: 480, scales: [2, 4, 8], runs: 5, warmup: 2 },
      { width: 1280, height: 720, scales: [2, 4], runs: 3, warmup: 1 },
      { width: 1920, height: 1080, scales: [2, 4], runs: 3, warmup: 1 },
      { width: 2560, height: 1440, scales: [2], runs: 2, warmup: 1 },
      { width: 3840, height: 2160, scales: [2], runs: 1, warmup: 0 },
    ];

/**
 * Sizes past the point where timing is the interesting question.
 *
 * These are not timed. A 6000x4000 source at 2x is a 96 megapixel result, and
 * the canvas baseline alone spends minutes encoding a PNG that large - a number
 * that says more about the browser's PNG encoder than about this library. What
 * matters here is whether the library handles the size or refuses it, and
 * whether the refusal is the precise, actionable kind. So these cases record
 * the outcome and, when it succeeds, how long it took - once.
 */
const LIMITS = QUICK
  ? []
  : [
      { width: 6000, height: 4000, scale: 2 },
      { width: 8000, height: 6000, scale: 2 },
      { width: 4000, height: 3000, scale: 4 },
      { width: 8000, height: 6000, scale: 8 },
    ];

const QUALITY = QUICK
  ? [
      { width: 512, height: 512, scale: 2 },
      { width: 512, height: 512, scale: 4 },
      { width: 1024, height: 768, scale: 2 },
    ]
  : [
      { width: 512, height: 512, scale: 2 },
      { width: 512, height: 512, scale: 4 },
      { width: 1024, height: 768, scale: 2 },
    ];

function startServer() {
  const child = spawn(process.execPath, ['tests/e2e/server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 15000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('listening')) {
        clearTimeout(timer);
        resolvePromise(child);
      }
    });
    child.on('error', reject);
  });
}

async function main() {
  const server = await startServer();
  const browser = await chromium.launch({
    args: ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader'],
  });

  try {
    const page = await browser.newPage();
    page.on('pageerror', (error) => console.error('[page error]', error.message));
    await page.goto(`${BASE}/benchmarks/bench.html`);
    await page.waitForFunction(() => window.benchReady === true, undefined, { timeout: 30000 });

    const capabilities = await page.evaluate(() => window.bench.detectCapabilities());
    console.log('\nEnvironment');
    console.log('  chromium   ', browser.version());
    console.log('  node       ', process.version);
    console.log('  platform   ', `${process.platform} ${process.arch}`);
    console.log('  cores      ', capabilities.hardwareConcurrency);
    console.log('  WebGPU     ', capabilities.webGPU);
    console.log('  WebGL2     ', capabilities.webGL2);
    console.log('  WASM SIMD  ', capabilities.wasmSimd);
    console.log('  memory est.', `${Math.round(capabilities.estimatedMemory / 1e6)} MB`);

    let aiAvailable = false;
    if (WITH_AI) {
      process.stdout.write('\nDownloading the AI model (67 MB, once)... ');
      aiAvailable = await page.evaluate(() => window.bench.ensureModel('realesrgan-x2'));
      console.log(aiAvailable ? 'done' : 'FAILED (AI cases will be skipped)');
    }

    // --- throughput -------------------------------------------------------

    console.log('\nThroughput');
    const throughput = [];
    for (const group of THROUGHPUT) {
      for (const scale of group.scales) {
        const cases = [
          { engine: 'canvas', mode: '-' },
          { engine: 'classical', mode: 'natural' },
          { engine: 'classical', mode: 'balanced' },
        ];
        // AI cases are measured once, without a warm-up run.
        //
        // Inference on the WASM backend takes tens of seconds per tile, so the
        // five-run median used for the classical cases would put this section
        // into the tens of minutes for no extra information: the variance
        // between AI runs is a rounding error next to the absolute time. The
        // session-creation cost is excluded because the session is created on
        // the first call and reused, which is also how a real application uses
        // it.
        if (aiAvailable && group.width <= 1280 && scale === 2) {
          cases.push({ engine: 'ai', mode: 'balanced', runs: 1, warmup: 0 });
          cases.push({ engine: 'hybrid', mode: 'balanced', runs: 1, warmup: 0 });
        }

        for (const item of cases) {
          const label = `${group.width}x${group.height} ${scale}x ${item.engine}/${item.mode}`;
          process.stdout.write(`  ${label.padEnd(46)}`);
          const result =
            item.engine === 'canvas'
              ? await page.evaluate(
                  (payload) => window.bench.timeCanvas(payload),
                  { width: group.width, height: group.height, scale, runs: group.runs, warmup: group.warmup },
                )
              : await page.evaluate((payload) => window.bench.timeCase(payload), {
                  width: group.width,
                  height: group.height,
                  scale,
                  engine: item.engine,
                  mode: item.mode,
                  runs: item.runs ?? group.runs,
                  warmup: item.warmup ?? group.warmup,
                });

          throughput.push(result);
          if (result.ok) {
            console.log(
              `${fmt(result.median, 0).padStart(9)} ms  ${fmt(result.megapixelsPerSecond, 2).padStart(7)} MP/s` +
                (result.tiles > 1 ? `  ${result.tiles} tiles` : ''),
            );
          } else {
            console.log(`refused: ${result.code}`);
          }
        }
      }
    }

    // --- limits -----------------------------------------------------------

    const limits = [];
    if (LIMITS.length > 0) {
      console.log('\nLimits (handled or refused, not timed against a baseline)');
      for (const spec of LIMITS) {
        const outputPixels = spec.width * spec.scale * spec.height * spec.scale;
        const label = `${spec.width}x${spec.height} ${spec.scale}x -> ${(outputPixels / 1e6).toFixed(0)} MP`;
        process.stdout.write(`  ${label.padEnd(40)}`);
        const result = await page.evaluate((payload) => window.bench.timeCase(payload), {
          width: spec.width,
          height: spec.height,
          scale: spec.scale,
          engine: 'classical',
          mode: 'natural',
          runs: 1,
          warmup: 0,
        });
        limits.push({ ...result, outputMegapixels: outputPixels / 1e6 });
        console.log(
          result.ok
            ? `handled in ${fmt(result.median, 0)} ms${result.tiles > 1 ? ` (${result.tiles} tiles)` : ''}`
            : `refused: ${result.code}`,
        );
      }
    }

    // --- quality ----------------------------------------------------------

    console.log('\nQuality (downscale, re-upscale, compare with the original)');
    const OFF = {
      sharpening: 0,
      detail: 0,
      noiseReduction: 0,
      edgeProtection: 0,
      antiRinging: 0,
    };

    const methods = [
      { kind: 'canvas', smoothing: 'none', label: 'canvas nearest' },
      { kind: 'canvas', smoothing: 'low', label: 'canvas low' },
      { kind: 'canvas', smoothing: 'high', label: 'canvas high (drawImage)' },
      // The same kernel run in each working colour space, to separate the
      // effect of linearisation from the effect of the kernel.
      { kind: 'raw', kernel: 'lanczos3', linear: true, label: 'raw lanczos3 (linear light)' },
      { kind: 'raw', kernel: 'lanczos3', linear: false, label: 'raw lanczos3 (sRGB space)' },
      { kind: 'raw', kernel: 'bicubic', linear: false, label: 'raw bicubic (sRGB space)' },
      { kind: 'raw', kernel: 'bilinear', linear: false, label: 'raw bilinear (sRGB space)' },
      // Every enhancement disabled: this is the bare Lanczos-3 resample in
      // linear light, and it isolates the resampler from the passes built on
      // top of it. Without this row it is impossible to tell whether a quality
      // difference comes from the interpolation or from the sharpening.
      {
        kind: 'library',
        engine: 'classical',
        mode: 'natural',
        tuning: OFF,
        label: 'lanczos3 only (no enhancement)',
      },
      {
        kind: 'library',
        engine: 'classical',
        mode: 'natural',
        tuning: { ...OFF, antiRinging: 0.85 },
        label: 'lanczos3 + anti-ring',
      },
      { kind: 'library', engine: 'classical', mode: 'natural', label: 'classical natural' },
      { kind: 'library', engine: 'classical', mode: 'balanced', label: 'classical balanced' },
      { kind: 'library', engine: 'classical', mode: 'detail', label: 'classical detail' },
      { kind: 'library', engine: 'classical', mode: 'document', label: 'classical document' },
    ];
    if (aiAvailable) {
      methods.push({ kind: 'library', engine: 'ai', mode: 'balanced', model: 'realesrgan-x2', label: 'AI (Real-ESRGAN 2x)' });
      methods.push({ kind: 'library', engine: 'hybrid', mode: 'balanced', model: 'realesrgan-x2', label: 'hybrid' });
    }

    const quality = [];
    for (const spec of QUALITY) {
      // The AI model is 2x only, so it cannot be scored at 4x.
      const applicable = spec.scale === 2 ? methods : methods.filter((m) => m.engine !== 'ai' && m.engine !== 'hybrid');
      console.log(`\n  ${spec.width}x${spec.height} at ${spec.scale}x`);
      const result = await page.evaluate(
        (payload) => window.bench.qualityCase(payload),
        { ...spec, methods: applicable },
      );
      quality.push(result);
      for (const row of result.rows) {
        if (row.ok) {
          console.log(
            `    ${row.label.padEnd(26)} PSNR ${fmt(row.psnr, 2).padStart(6)} dB` +
              `   SSIM ${fmt(row.ssim, 4)}   MAE ${fmt(row.mae, 2).padStart(5)}   MSE ${fmt(row.mse, 1).padStart(6)}`,
          );
        } else {
          console.log(`    ${row.label.padEnd(26)} failed: ${row.code}`);
        }
      }
    }

    // --- output -----------------------------------------------------------

    const record = {
      generatedAt: new Date().toISOString(),
      environment: {
        chromium: browser.version(),
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        capabilities,
      },
      throughput,
      limits,
      quality,
    };

    const outDir = resolve(ROOT, 'benchmarks/results');
    await mkdir(outDir, { recursive: true });
    await writeFile(resolve(outDir, 'latest.json'), `${JSON.stringify(record, null, 2)}\n`);

    const markdown = renderMarkdown(record);
    await writeFile(resolve(outDir, 'latest.md'), markdown);
    console.log(`\nWrote benchmarks/results/latest.json and latest.md`);
  } finally {
    await browser.close();
    server.kill();
  }
}

await main();
